import type { AudioSource, Track } from "../shared/types";
import type { BufferLookup } from "./buffers";
import { type Clip, EQ_KILL_DB, type Lane, type Project, laneRate, laneSources, projectEndBeat } from "./project";

const SOURCES: AudioSource[] = ["mix", "vocals", "drums", "bass", "other"];
const OPEN_LP = 20000;
const OPEN_HP = 10;
const SMOOTH = 0.015;
/** Automation resolution: 16 points per beat is ~30 ms at 128 BPM, fine enough for swaps and sweeps. */
const AUTOMATION_STEPS_PER_BEAT = 16;
const SOURCE_FADE = 0.004;

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, frequency: number, gain = 0, q = 0.7071): BiquadFilterNode {
  return new BiquadFilterNode(ctx, { type, frequency, gain, Q: q });
}

/**
 * One mixer channel:
 * sources → per-stem gain → clip automation (fade, sweep filters, bass swap) → 3-band EQ
 * → DJ filter → fader → master, with echo and reverb sends after the fader.
 */
class LaneNodes {
  readonly inputs: Record<AudioSource, GainNode>;
  readonly autoGain: GainNode;
  readonly autoLP: BiquadFilterNode;
  readonly autoHP: BiquadFilterNode;
  readonly autoLow: BiquadFilterNode;
  readonly autoEcho: GainNode;
  private readonly eqLow: BiquadFilterNode;
  private readonly eqMid: BiquadFilterNode;
  private readonly eqHigh: BiquadFilterNode;
  private readonly djHP: BiquadFilterNode;
  private readonly djLP: BiquadFilterNode;
  private readonly fader: GainNode;
  private readonly echoSend: GainNode;
  private readonly reverbSend: GainNode;
  readonly meter: AnalyserNode;

  constructor(
    private readonly ctx: BaseAudioContext,
    out: { master: AudioNode; echo: AudioNode; reverb: AudioNode },
  ) {
    this.inputs = Object.fromEntries(SOURCES.map((s) => [s, new GainNode(ctx)])) as Record<AudioSource, GainNode>;
    this.autoGain = new GainNode(ctx);
    this.autoLP = biquad(ctx, "lowpass", OPEN_LP);
    this.autoHP = biquad(ctx, "highpass", OPEN_HP);
    this.autoLow = biquad(ctx, "lowshelf", 220);
    this.eqLow = biquad(ctx, "lowshelf", 250);
    this.eqMid = biquad(ctx, "peaking", 1000, 0, 0.7);
    this.eqHigh = biquad(ctx, "highshelf", 4000);
    this.djHP = biquad(ctx, "highpass", OPEN_HP, 0, 1.2);
    this.djLP = biquad(ctx, "lowpass", OPEN_LP, 0, 1.2);
    this.fader = new GainNode(ctx);
    this.echoSend = new GainNode(ctx, { gain: 0 });
    this.autoEcho = new GainNode(ctx, { gain: 0 });
    this.reverbSend = new GainNode(ctx, { gain: 0 });
    this.meter = new AnalyserNode(ctx, { fftSize: 512 });

    for (const input of Object.values(this.inputs)) input.connect(this.autoGain);
    this.autoGain
      .connect(this.autoLP)
      .connect(this.autoHP)
      .connect(this.autoLow)
      .connect(this.eqLow)
      .connect(this.eqMid)
      .connect(this.eqHigh)
      .connect(this.djHP)
      .connect(this.djLP)
      .connect(this.fader)
      .connect(out.master);
    this.fader.connect(this.meter);
    this.fader.connect(this.echoSend).connect(out.echo);
    this.fader.connect(this.autoEcho).connect(out.echo);
    this.fader.connect(this.reverbSend).connect(out.reverb);
  }

  /** `immediate` jumps straight to the values: used for new lanes, so nothing leaks before they settle. */
  apply(lane: Lane, audible: boolean, immediate: boolean): void {
    const { ctx } = this;
    const setSmooth = immediate
      ? (param: AudioParam, value: number) => param.setValueAtTime(value, ctx.currentTime)
      : (param: AudioParam, value: number) => param.setTargetAtTime(value, ctx.currentTime, SMOOTH);
    for (const [stem, gain] of Object.entries(lane.stemGain)) setSmooth(this.inputs[stem as AudioSource].gain, gain);
    setSmooth(this.eqLow.gain, lane.eq.low);
    setSmooth(this.eqMid.gain, lane.eq.mid);
    setSmooth(this.eqHigh.gain, lane.eq.high);
    // One knob, two filters: left of centre closes a low-pass, right of centre opens a high-pass.
    const amount = Math.abs(lane.filter) < 0.02 ? 0 : lane.filter;
    setSmooth(this.djLP.frequency, amount < 0 ? OPEN_LP * (60 / OPEN_LP) ** -amount : OPEN_LP);
    setSmooth(this.djHP.frequency, amount > 0 ? OPEN_HP * (8000 / OPEN_HP) ** amount : OPEN_HP);
    setSmooth(this.fader.gain, audible ? lane.volume : 0);
    setSmooth(this.echoSend.gain, lane.echo);
    setSmooth(this.reverbSend.gain, lane.reverb);
  }

  resetAutomation(): void {
    const t = this.ctx.currentTime;
    for (const [param, value] of this.automated()) {
      param.cancelScheduledValues(0);
      param.setValueAtTime(value, t);
    }
  }

  /** Clip-automated params with their resting values, in the order clipAutomation() reports them. */
  automated(): [AudioParam, number][] {
    return [
      [this.autoGain.gain, 1],
      [this.autoLP.frequency, OPEN_LP],
      [this.autoHP.frequency, OPEN_HP],
      [this.autoLow.gain, 0],
      [this.autoEcho.gain, 0],
    ];
  }

  disconnect(): void {
    for (const input of Object.values(this.inputs)) input.disconnect();
    this.fader.disconnect();
  }
}

function impulseResponse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  }
  return buffer;
}

/** The whole mixer. Works on a live AudioContext and on an OfflineAudioContext for export. */
export class MixGraph {
  readonly lanes = new Map<string, LaneNodes>();
  readonly output: GainNode;
  readonly analyser: AnalyserNode;
  private readonly echoIn: GainNode;
  private readonly echoDelay: DelayNode;
  private readonly reverbIn: GainNode;

  constructor(readonly ctx: BaseAudioContext) {
    this.output = new GainNode(ctx, { gain: 0.9 });
    const limiter = new DynamicsCompressorNode(ctx, { threshold: -3, knee: 2, ratio: 20, attack: 0.002, release: 0.15 });
    this.analyser = new AnalyserNode(ctx, { fftSize: 2048 });
    this.output.connect(limiter).connect(this.analyser).connect(ctx.destination);

    this.echoIn = new GainNode(ctx);
    this.echoDelay = new DelayNode(ctx, { maxDelayTime: 4, delayTime: 0.35 });
    const feedback = new GainNode(ctx, { gain: 0.5 });
    const tone = biquad(ctx, "bandpass", 1600, 0, 0.6);
    this.echoIn.connect(this.echoDelay).connect(tone).connect(feedback).connect(this.echoDelay);
    tone.connect(new GainNode(ctx, { gain: 0.8 })).connect(this.output);

    this.reverbIn = new GainNode(ctx);
    const convolver = new ConvolverNode(ctx, { buffer: impulseResponse(ctx, 2.8) });
    this.reverbIn.connect(convolver).connect(new GainNode(ctx, { gain: 0.7 })).connect(this.output);
  }

  sync(project: Project): void {
    // Dotted eighth echo locks to the beat.
    this.echoDelay.delayTime.setTargetAtTime(0.75 * (60 / project.masterBpm), this.ctx.currentTime, 0.05);
    const ids = new Set(project.lanes.map((l) => l.id));
    for (const [id, nodes] of this.lanes) {
      if (!ids.has(id)) {
        nodes.disconnect();
        this.lanes.delete(id);
      }
    }
    const anySolo = project.lanes.some((l) => l.solo);
    for (const lane of project.lanes) {
      let nodes = this.lanes.get(lane.id);
      const created = !nodes;
      if (!nodes) {
        nodes = new LaneNodes(this.ctx, { master: this.output, echo: this.echoIn, reverb: this.reverbIn });
        this.lanes.set(lane.id, nodes);
      }
      nodes.apply(lane, !lane.mute && (!anySolo || lane.solo), created);
    }
  }
}

interface Automation {
  gain: number;
  lp: number;
  hp: number;
  low: number;
  echo: number;
}

/** Automation values a clip asks for at `u` beats after its start. */
function clipAutomation(clip: Clip, u: number): Automation {
  const v = clip.length - u;
  const a: Automation = { gain: 1, lp: OPEN_LP, hp: OPEN_HP, low: 0, echo: 0 };
  if (clip.fadeIn > 0 && u < clip.fadeIn) {
    const k = Math.max(0, u / clip.fadeIn);
    if (clip.inStyle === "fade") a.gain *= Math.sin((k * Math.PI) / 2);
    else {
      a.lp = 150 * (OPEN_LP / 150) ** k;
      a.gain *= 0.5 + 0.5 * k;
    }
  }
  if (clip.fadeOut > 0 && v < clip.fadeOut) {
    const k = Math.max(0, v / clip.fadeOut);
    if (clip.outStyle === "fade") a.gain *= Math.sin((k * Math.PI) / 2);
    else if (clip.outStyle === "filter") {
      a.hp = OPEN_HP * (3000 / OPEN_HP) ** (1 - k);
      a.gain *= 0.5 + 0.5 * k;
    } else a.echo = 0.9 * (1 - k);
  }
  if (u < clip.bassIn || (clip.bassOut !== null && u >= clip.bassOut)) a.low = EQ_KILL_DB;
  return a;
}

/**
 * Clip automation as one sampled curve per param. Samples sit on the absolute beat grid, so clip
 * edges (whole beats) always land on a sample, and a clip's end sample keeps its own value: a
 * fade-out reaches zero instead of interpolating back up to the resting value.
 */
function scheduleAutomation(nodes: LaneNodes, clips: Clip[], fromBeat: number, t0: number, spb: number): void {
  const first = Math.floor(fromBeat * AUTOMATION_STEPS_PER_BEAT) / AUTOMATION_STEPS_PER_BEAT;
  const curveStart = Math.max(0, t0 - (fromBeat - first) * spb);
  const end = clips.reduce((e, c) => Math.max(e, c.start + c.length), fromBeat);
  const steps = Math.ceil((end - first) * AUTOMATION_STEPS_PER_BEAT) + 1;
  const params = nodes.automated();
  for (const [param, value] of params) {
    param.cancelScheduledValues(0);
    param.setValueAtTime(value, Math.max(0, curveStart - 0.01));
  }
  if (steps < 2) return;
  const curves = params.map(() => new Float32Array(steps));
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  for (let i = 0; i < steps; i++) {
    const beat = first + i / AUTOMATION_STEPS_PER_BEAT;
    // When clips overlap or touch on a lane, the one that started last wins.
    const clip = sorted.findLast((c) => c.start <= beat && beat <= c.start + c.length);
    const a = clip ? clipAutomation(clip, beat - clip.start) : null;
    const values = [a?.gain ?? 1, a?.lp ?? OPEN_LP, a?.hp ?? OPEN_HP, a?.low ?? 0, a?.echo ?? 0];
    values.forEach((v, p) => {
      curves[p]![i] = v;
    });
  }
  const duration = (steps - 1) / AUTOMATION_STEPS_PER_BEAT * spb;
  params.forEach(([param], p) => param.setValueCurveAtTime(curves[p]!, curveStart, duration));
}

/**
 * Starts every clip that is audible from `fromBeat`, with the timeline's `fromBeat` at context
 * time `t0`. Returns the source nodes so the caller can stop them.
 */
export function schedule(
  graph: MixGraph,
  project: Project,
  tracks: Map<string, Track>,
  buffers: BufferLookup,
  fromBeat: number,
  t0: number,
): AudioScheduledSourceNode[] {
  const { ctx } = graph;
  const spb = 60 / project.masterBpm;
  const started: AudioScheduledSourceNode[] = [];
  for (const lane of project.lanes) {
    const track = tracks.get(lane.trackId);
    const nodes = graph.lanes.get(lane.id);
    if (!track?.analysis || !nodes) continue;
    const clips = project.clips.filter((c) => c.laneId === lane.id);
    scheduleAutomation(nodes, clips, fromBeat, t0, spb);
    const rate = laneRate(project.masterBpm, lane, track.analysis);
    for (const clip of clips) {
      const clipEnd = clip.start + clip.length;
      if (clipEnd <= fromBeat) continue;
      let when = t0 + Math.max(0, clip.start - fromBeat) * spb;
      let offset = (clip.srcStart + lane.nudge) / rate + Math.max(0, fromBeat - clip.start) * spb;
      let duration = (clipEnd - Math.max(clip.start, fromBeat)) * spb;
      if (offset < 0) {
        // The clip starts before the song does (pickup bar): wait out the silence.
        when -= offset;
        duration += offset;
        offset = 0;
      }
      if (duration <= SOURCE_FADE * 2) continue;
      for (const source of laneSources(track, [clip])) {
        if (source !== "mix" && !clip.stems[source]) continue;
        const buffer = buffers({ trackId: track.id, source, rate, semitones: lane.semitones });
        if (!buffer || offset >= buffer.duration) continue;
        const node = new AudioBufferSourceNode(ctx, { buffer });
        const edge = new GainNode(ctx, { gain: 0 });
        edge.gain.setValueAtTime(0, when);
        edge.gain.linearRampToValueAtTime(1, when + SOURCE_FADE);
        edge.gain.setValueAtTime(1, when + duration - SOURCE_FADE);
        edge.gain.linearRampToValueAtTime(0, when + duration);
        node.connect(edge).connect(nodes.inputs[source]);
        node.start(when, offset, duration);
        node.onended = () => edge.disconnect();
        started.push(node);
      }
    }
  }
  return started;
}

/** Live playback on top of the mixer graph. Positions are in master beats. */
export class Engine {
  readonly ctx = new AudioContext({ sampleRate: 44100, latencyHint: "interactive" });
  readonly graph = new MixGraph(this.ctx);
  private sources: AudioScheduledSourceNode[] = [];
  private startTime = 0;
  private startBeat = 0;
  private bpm = 124;
  private cursor = 0;
  playing = false;

  position(): number {
    if (!this.playing) return this.cursor;
    return this.startBeat + Math.max(0, this.ctx.currentTime - this.startTime) * (this.bpm / 60);
  }

  /** Without `fromBeat` it continues from the current position (or the cursor when stopped). */
  async play(project: Project, tracks: Map<string, Track>, buffers: BufferLookup, fromBeat?: number): Promise<void> {
    await this.ctx.resume();
    const startTime = this.ctx.currentTime + 0.05;
    const startBeat =
      fromBeat ?? (this.playing ? this.startBeat + (startTime - this.startTime) * (this.bpm / 60) : this.cursor);
    this.stopSources();
    this.bpm = project.masterBpm;
    this.startBeat = startBeat;
    this.startTime = startTime;
    this.sources = schedule(this.graph, project, tracks, buffers, startBeat, startTime);
    this.playing = true;
  }

  pause(): void {
    this.cursor = this.position();
    this.playing = false;
    this.stopSources();
  }

  seek(beat: number): void {
    this.cursor = Math.max(0, beat);
  }

  private stopSources(): void {
    for (const s of this.sources) {
      s.onended = null;
      s.stop();
    }
    this.sources = [];
    for (const nodes of this.graph.lanes.values()) nodes.resetAutomation();
  }
}

/** Renders the arrangement to a stereo buffer, including a few seconds of echo and reverb tail. */
export async function renderMix(project: Project, tracks: Map<string, Track>, buffers: BufferLookup): Promise<AudioBuffer> {
  const seconds = projectEndBeat(project) * (60 / project.masterBpm) + 4;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * 44100), 44100);
  const graph = new MixGraph(ctx);
  graph.sync(project);
  schedule(graph, project, tracks, buffers, 0, 0);
  return ctx.startRendering();
}
