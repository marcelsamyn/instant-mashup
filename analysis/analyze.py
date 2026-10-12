# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["librosa==0.11.0", "soundfile>=0.12", "numpy>=1.26,<3", "scipy>=1.11"]
# ///
"""Music analysis for the mashup app.

  analyze.py track <audio.wav>                  -> track analysis JSON on stdout
  analyze.py stems <analysis.json> <stems dir>  -> per-bar stem levels (dBFS) JSON on stdout
"""

import json
import sys

import librosa
import numpy as np
import soundfile as sf
from scipy.cluster.hierarchy import fcluster, linkage

SR = 22050
HOP = 512
WAVE_HOP = 441  # 50 waveform columns per second
NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
# Camelot wheel number for each major tonic; a minor key shares the number of its relative major.
CAMELOT_MAJOR = {0: 8, 7: 9, 2: 10, 9: 11, 4: 12, 11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7}
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def zscore(x: np.ndarray) -> np.ndarray:
    return (x - x.mean()) / (x.std() + 1e-9)


def unit_range(x: np.ndarray, lo_pct: float = 5, hi_pct: float = 95) -> np.ndarray:
    lo, hi = np.percentile(x, [lo_pct, hi_pct])
    return np.clip((x - lo) / (hi - lo + 1e-9), 0, 1)


def segment_means(feat: np.ndarray, bounds: np.ndarray) -> np.ndarray:
    """Mean of feature columns between consecutive frame bounds -> (len(bounds)-1, dims)."""
    out = np.zeros((len(bounds) - 1, feat.shape[0]))
    for i in range(len(bounds) - 1):
        a, b = bounds[i], max(bounds[i + 1], bounds[i] + 1)
        out[i] = feat[:, a:b].mean(axis=1)
    return out


def tracked_period(onset: np.ndarray) -> float:
    """Seconds per beat from a constant-tempo fit to librosa's tracked beats."""
    _, frames = librosa.beat.beat_track(onset_envelope=onset, sr=SR, hop_length=HOP)
    times = librosa.frames_to_time(frames, sr=SR, hop_length=HOP)
    if len(times) < 16:
        raise ValueError("No steady beat found in this audio")
    period = float(np.median(np.diff(times)))
    idx = np.round((times - times[0]) / period)
    keep = np.ones(len(times), dtype=bool)
    slope = period
    for _ in range(4):
        slope, icept = np.polyfit(idx[keep], times[keep], 1)
        resid = np.abs(times - (slope * idx + icept))
        keep = resid < max(0.03, 2.5 * float(np.median(resid[keep])))
    return float(slope)


def refine_grid(y: np.ndarray, period: float) -> tuple[float, float]:
    """
    Sharpen the tracked tempo: fold a fine onset envelope over candidate beat periods and keep the
    one where onsets pile up tightest. A 0.5 BPM error drifts a full beat within a few minutes, so
    beat matching needs this precision. Returns (seconds per beat, time of a beat).
    """
    hop = 128
    onset = librosa.onset.onset_strength(y=y, sr=SR, hop_length=hop)
    t = np.arange(len(onset)) * hop / SR

    def fold(p: float) -> tuple[float, float]:
        hist = np.bincount(((t % p) / p * 128).astype(int), weights=onset, minlength=128)[:128]
        smooth = np.convolve(np.r_[hist[-2:], hist, hist[:2]], np.ones(5) / 5, "valid")
        return float(smooth.max() / (smooth.mean() + 1e-9)), float(np.argmax(smooth) / 128 * p)

    bpm = 60 / period
    for span, step in ((0.03 * bpm, 0.05), (0.1, 0.002)):
        candidates = np.arange(bpm - span, bpm + span, step)
        bpm = float(candidates[int(np.argmax([fold(60 / b)[0] for b in candidates]))])
    best = 60 / bpm
    return best, fold(best)[1]


def downbeat_phase(beat_times: np.ndarray, low_onset: np.ndarray, chroma: np.ndarray) -> int:
    """Pick which of the 4 beat phases starts the bar: kicks and chord changes land on downbeats."""
    frames = np.clip(librosa.time_to_frames(beat_times, sr=SR, hop_length=HOP), 0, chroma.shape[1] - 1)
    kick = np.array([low_onset[max(f - 2, 0) : f + 3].max() for f in frames])
    beat_chroma = segment_means(chroma, np.append(frames, chroma.shape[1]))
    norm = beat_chroma / (np.linalg.norm(beat_chroma, axis=1, keepdims=True) + 1e-9)
    change = np.concatenate([[0.0], 1 - np.sum(norm[1:] * norm[:-1], axis=1)])
    score = zscore(kick) + zscore(change)
    return int(np.argmax([score[k::4].mean() for k in range(4)]))


def detect_key(chroma: np.ndarray) -> dict:
    profile = chroma.mean(axis=1)
    scores = []
    for tonic in range(12):
        rolled = np.roll(profile, -tonic)
        scores.append((np.corrcoef(rolled, KK_MAJOR)[0, 1], tonic, False))
        scores.append((np.corrcoef(rolled, KK_MINOR)[0, 1], tonic, True))
    scores.sort(reverse=True)
    best, tonic, minor = scores[0]
    number = CAMELOT_MAJOR[(tonic + 3) % 12] if minor else CAMELOT_MAJOR[tonic]
    return {
        "name": f"{NOTE_NAMES[tonic]}{'m' if minor else ''}",
        "camelot": f"{number}{'A' if minor else 'B'}",
        "tonic": tonic,
        "minor": minor,
        "confidence": round(float(best - scores[1][0]), 3),
    }


def novelty_curve(features: np.ndarray, energy_db: np.ndarray, half: int = 8) -> np.ndarray:
    """Foote checkerboard novelty on the bar self-similarity matrix, plus loudness jumps."""
    n = len(features)
    unit = features / (np.linalg.norm(features, axis=1, keepdims=True) + 1e-9)
    ssm = unit @ unit.T
    taper = np.exp(-0.5 * (np.linspace(-2, 2, 2 * half)) ** 2)
    sign = np.sign(np.arange(2 * half) - half + 0.5)
    kernel = np.outer(sign, sign) * np.outer(taper, taper)
    padded = np.pad(ssm, half, mode="edge")
    timbre = np.zeros(n)
    for i in range(1, n):
        timbre[i] = max(0.0, float(np.sum(padded[i : i + 2 * half, i : i + 2 * half] * kernel)))
    jumps = np.zeros(n)
    spread = energy_db.std() + 1e-9
    for i in range(1, n):
        jumps[i] = abs(energy_db[i : i + 4].mean() - energy_db[max(i - 4, 0) : i].mean()) / spread
    nov = timbre / (timbre.max() + 1e-9) + 0.7 * jumps / (jumps.max() + 1e-9)
    nov[:2] = 0
    return nov / (nov.max() + 1e-9)


def pick_boundaries(nov: np.ndarray, n_bars: int) -> list[int]:
    """Phrase-aligned section starts: strongest novelty peaks on a 4-bar grid, at least 8 bars apart."""
    phase = int(np.argmax([nov[p::4].sum() for p in range(4)]))
    candidates = sorted(range(phase or 4, n_bars, 4), key=lambda i: -nov[i])
    chosen: list[int] = []
    for i in candidates:
        if nov[i] < 0.15 or len(chosen) >= n_bars // 8:
            break
        if n_bars - i >= 4 and all(abs(i - c) >= 8 for c in chosen):
            chosen.append(i)
    starts = sorted([0, *chosen])
    # Very long sections are hard to rearrange: split them at their strongest inner phrase change.
    while True:
        ends = [*starts[1:], n_bars]
        long = [(a, b) for a, b in zip(starts, ends) if b - a > 32]
        if not long:
            break
        a, b = long[0]
        inner = [i for i in range(a + 8, b - 7) if i % 4 == phase % 4]
        starts = sorted([*starts, max(inner, key=lambda i: nov[i]) if inner else (a + b) // 2])
    if len(starts) > 1 and starts[1] < 4:  # fold a short pickup into the first phrase
        starts.pop(1)
    return starts


def label_sections(energy: list[float]) -> list[str]:
    n = len(energy)
    peak = max(energy)
    median = float(np.median(energy))
    labels = []
    for i, e in enumerate(energy):
        if e >= max(0.55, peak - 0.15):
            labels.append("Chorus")
        elif e < 0.35 and 0 < i < n - 1:
            labels.append("Breakdown")
        else:
            labels.append("Verse")
    if n > 1 and energy[0] < max(0.5, median):
        labels[0] = "Intro"
    if n > 2 and energy[-1] < median + 0.05:
        labels[-1] = "Outro"
    for i in range(1, n - 1):
        if labels[i] in ("Verse", "Breakdown") and labels[i + 1] == "Chorus" and energy[i] > energy[i - 1]:
            labels[i] = "Build"
    return labels


def group_sections(section_features: np.ndarray) -> list[str]:
    if len(section_features) < 2:
        return ["A"] * len(section_features)
    tree = linkage(section_features, method="average", metric="cosine")
    ids = fcluster(tree, t=0.12, criterion="distance")
    letters: dict[int, str] = {}
    return [letters.setdefault(int(i), chr(ord("A") + len(letters) % 26)) for i in ids]


def waveform(y: np.ndarray) -> dict:
    spec = np.abs(librosa.stft(y, n_fft=2048, hop_length=WAVE_HOP)) ** 2
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    bands = {"low": freqs < 200, "mid": (freqs >= 200) & (freqs < 2500), "high": freqs >= 2500}
    out: dict = {"rate": SR / WAVE_HOP}
    for name, mask in bands.items():
        amp = np.sqrt(spec[mask].mean(axis=0))
        scaled = np.clip(amp / (np.percentile(amp, 99.5) + 1e-9), 0, 1) ** 0.8
        out[name] = np.round(scaled * 255).astype(int).tolist()
    return out


def analyze_track(path: str) -> dict:
    y, _ = librosa.load(path, sr=SR, mono=True)
    duration = len(y) / SR
    onset = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    mel_db = librosa.power_to_db(librosa.feature.melspectrogram(y=y, sr=SR, hop_length=HOP, n_mels=64))
    low_onset = librosa.onset.onset_strength(S=mel_db[:6], sr=SR, hop_length=HOP)
    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=HOP)
    mfcc = librosa.feature.mfcc(S=mel_db, n_mfcc=13)
    rms_db = librosa.amplitude_to_db(librosa.feature.rms(y=y, hop_length=HOP), ref=1.0)
    low_db = mel_db[:8].mean(axis=0, keepdims=True)

    beat_sec, beat_ref = refine_grid(y, tracked_period(onset))
    first_beat = beat_ref - np.floor(beat_ref / beat_sec) * beat_sec
    beat_times = np.arange(first_beat, duration, beat_sec)
    downbeat = first_beat + downbeat_phase(beat_times, low_onset, chroma) * beat_sec
    bar_sec = 4 * beat_sec
    bar0 = downbeat - np.ceil(downbeat / bar_sec) * bar_sec
    n_bars = int(np.ceil((duration - bar0) / bar_sec))
    bar_times = bar0 + np.arange(n_bars + 1) * bar_sec
    n_frames = chroma.shape[1]
    bounds = np.clip(librosa.time_to_frames(bar_times, sr=SR, hop_length=HOP), 0, n_frames)

    bar_chroma = segment_means(chroma, bounds)
    bar_mfcc = segment_means(mfcc[1:], bounds)
    bar_rms = segment_means(rms_db, bounds)[:, 0]
    bar_onset = segment_means(onset[None, :n_frames], bounds)[:, 0]
    bar_low = segment_means(low_db, bounds)[:, 0]
    features = np.hstack([np.apply_along_axis(zscore, 0, bar_chroma), np.apply_along_axis(zscore, 0, bar_mfcc)])
    bar_energy = unit_range(0.55 * zscore(bar_rms) + 0.25 * zscore(bar_onset) + 0.2 * zscore(bar_low))

    starts = pick_boundaries(novelty_curve(features, bar_rms), n_bars)
    ends = [*starts[1:], n_bars]
    energy = [float(bar_energy[a:b].mean()) for a, b in zip(starts, ends)]
    labels = label_sections(energy)
    groups = group_sections(np.array([features[a:b].mean(axis=0) for a, b in zip(starts, ends)]))
    sections = [
        {
            "startBar": a,
            "bars": b - a,
            "start": round(float(bar_times[a]), 4),
            "end": round(float(min(bar_times[b], duration)), 4),
            "energy": round(e, 3),
            "label": label,
            "group": group,
        }
        for a, b, e, label, group in zip(starts, ends, energy, labels, groups)
    ]
    return {
        "duration": round(duration, 4),
        "bpm": round(60 / beat_sec, 3),
        "beatSec": beat_sec,
        "downbeat": float(bar0),
        "barCount": n_bars,
        "key": detect_key(chroma),
        "sections": sections,
        "barEnergy": np.round(bar_energy, 3).tolist(),
        "waveform": waveform(y),
    }


def stem_levels(analysis_path: str, stems_dir: str) -> dict:
    with open(analysis_path) as f:
        analysis = json.load(f)
    bar_sec = 4 * analysis["beatSec"]
    levels = {}
    for stem in ("vocals", "drums", "bass", "other"):
        audio, sr = sf.read(f"{stems_dir}/{stem}.wav", dtype="float32", always_2d=True)
        mono = audio.mean(axis=1)
        values = []
        for i in range(analysis["barCount"]):
            a = max(int((analysis["downbeat"] + i * bar_sec) * sr), 0)
            b = min(int((analysis["downbeat"] + (i + 1) * bar_sec) * sr), len(mono))
            rms = float(np.sqrt(np.mean(mono[a:b] ** 2))) if b > a else 0.0
            values.append(round(20 * np.log10(rms + 1e-9), 1))
        levels[stem] = values
    return levels


if __name__ == "__main__":
    command, *args = sys.argv[1:]
    if command == "track":
        result = analyze_track(args[0])
    elif command == "stems":
        result = stem_levels(args[0], args[1])
    else:
        raise SystemExit(f"Unknown command: {command}")
    json.dump(result, sys.stdout)
