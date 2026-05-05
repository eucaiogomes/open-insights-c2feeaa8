import { useEffect, useMemo, useRef, useState } from "react";
import {
  SkipBack, Play, Pause, SkipForward, Volume2, Maximize2, Scissors, Trash2, Save,
  Video, Image as ImageIcon, ArrowLeft, List, Upload, Film, Music, Plus,
} from "lucide-react";
import { useStudio } from "@/state/studio";
import ChaptersPanel from "@/components/ChaptersPanel";
import { toast } from "sonner";

type Kind = "video" | "slide" | "audio" | "image";
type Segment = {
  id: string;
  kind: Kind;
  layer: number;          // 0 = top
  start: number;          // absolute timeline position (sec)
  srcStart: number;       // source-in
  srcEnd: number;         // source-out
  label: string;
  mediaUrl?: string;      // for video/audio/image
  slideUrl?: string;      // for slide
};

const uid = () => Math.random().toString(36).slice(2, 9);
const lenOf = (s: Segment) => s.srcEnd - s.srcStart;
const endOf = (s: Segment) => s.start + lenOf(s);
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end - 1e-3 && b.start < a.end - 1e-3;

/** Find smallest layer index where placing [start, start+len) does not conflict, ignoring `ignoreId`. */
function findFreeLayer(segs: Segment[], start: number, len: number, ignoreId?: string, preferred?: number): number {
  const end = start + len;
  const tryLayer = (L: number) =>
    !segs.some((s) => s.id !== ignoreId && s.layer === L && overlaps({ start, end }, { start: s.start, end: endOf(s) }));
  if (preferred !== undefined && tryLayer(preferred)) return preferred;
  for (let L = 0; L < 64; L++) if (tryLayer(L)) return L;
  return 0;
}

export default function EditStudio() {
  const { recording, setView, appendRecording, setAppendRecording } = useStudio();
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const ovVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  // Build initial segments from recording — or a blank slide if starting fresh
  useEffect(() => {
    if (segments.length > 0) return;
    if (!recording) {
      setSegments([
        { id: uid(), kind: "slide", layer: 0, start: 0, srcStart: 0, srcEnd: 10, label: "Slide em branco" },
      ]);
      return;
    }
    const dur = recording.duration;
    const slideSegs: Segment[] = recording.slideMarkers.map((m, i) => {
      const next = recording.slideMarkers[i + 1]?.time ?? dur;
      const slide = recording.slides.find((s) => s.id === m.slideId);
      return {
        id: uid(), kind: "slide", layer: 0,
        start: m.time, srcStart: 0, srcEnd: next - m.time,
        label: slide?.name ?? `Slide ${i + 1}`, slideUrl: slide?.url,
      };
    });
    const initial: Segment[] = [
      ...slideSegs,
      { id: uid(), kind: "video", layer: 1, start: 0, srcStart: 0, srcEnd: dur, label: "Webcam", mediaUrl: recording.videoUrl },
      { id: uid(), kind: "audio", layer: 2, start: 0, srcStart: 0, srcEnd: dur, label: "Áudio", mediaUrl: recording.videoUrl },
    ];
    setSegments(initial);
  }, [recording]); // eslint-disable-line

  // Append new recording at end of timeline
  useEffect(() => {
    if (!appendRecording) return;
    const r = appendRecording;
    setSegments((prev) => {
      const tEnd = prev.reduce((a, s) => Math.max(a, endOf(s)), 0);
      const acc: Segment[] = [...prev];
      const place = (seg: Omit<Segment, "layer" | "id">, preferred?: number) => {
        const layer = findFreeLayer(acc, seg.start, seg.srcEnd - seg.srcStart, undefined, preferred);
        const full: Segment = { ...seg, id: uid(), layer };
        acc.push(full);
      };
      r.slideMarkers.forEach((m, i) => {
        const next = r.slideMarkers[i + 1]?.time ?? r.duration;
        const slide = r.slides.find((s) => s.id === m.slideId);
        place({ kind: "slide", start: tEnd + m.time, srcStart: 0, srcEnd: next - m.time, label: slide?.name ?? "Slide", slideUrl: slide?.url }, 0);
      });
      place({ kind: "video", start: tEnd, srcStart: 0, srcEnd: r.duration, label: "Webcam", mediaUrl: r.videoUrl }, 1);
      place({ kind: "audio", start: tEnd, srcStart: 0, srcEnd: r.duration, label: "Áudio", mediaUrl: r.videoUrl }, 2);
      return acc;
    });
    setAppendRecording(null);
    toast.success("Nova cena adicionada à timeline");
  }, [appendRecording, setAppendRecording]);

  const duration = useMemo(
    () => Math.max(5, segments.reduce((a, s) => Math.max(a, endOf(s)), 0)),
    [segments],
  );
  const layerCount = useMemo(
    () => Math.max(3, segments.reduce((a, s) => Math.max(a, s.layer + 1), 0) + 1),
    [segments],
  );

  // Active segments at current time, sorted by layer (top first)
  const active = useMemo(
    () => segments.filter((s) => time >= s.start && time < endOf(s)).sort((a, b) => a.layer - b.layer),
    [segments, time],
  );
  const mainVideo = active.find((s) => s.kind === "video");
  const mainSlide = active.find((s) => s.kind === "slide");
  const overlayImages = active.filter((s) => s.kind === "image");
  const activeAudios = active.filter((s) => s.kind === "audio" || s.kind === "video");

  // Sync main video element src
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!mainVideo?.mediaUrl) { v.removeAttribute("src"); return; }
    if (!v.src.includes(mainVideo.mediaUrl)) v.src = mainVideo.mediaUrl;
  }, [mainVideo?.mediaUrl]);

  // Playback loop
  useEffect(() => {
    if (!playing) return;
    let raf = 0; let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      setTime((prev) => {
        const nt = prev + dt;
        if (nt >= duration) { setPlaying(false); return duration; }
        return nt;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);

  // Sync media to playhead/playing
  useEffect(() => {
    const v = videoRef.current;
    if (v && mainVideo) {
      const target = mainVideo.srcStart + (time - mainVideo.start);
      if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
      if (playing) v.play().catch(() => {}); else v.pause();
    } else if (v) v.pause();
    Object.entries(audioRefs.current).forEach(([id, el]) => {
      if (!el) return;
      const seg = segments.find((s) => s.id === id);
      if (!seg) return;
      const isActive = activeAudios.some((a) => a.id === id);
      if (isActive) {
        const target = seg.srcStart + (time - seg.start);
        if (Math.abs(el.currentTime - target) > 0.3) el.currentTime = target;
        if (playing) el.play().catch(() => {}); else el.pause();
      } else el.pause();
    });
  }, [time, playing, mainVideo, activeAudios, segments]);

  // (No early return — editor opens with a blank slide when no recording exists.)

  // ===== ops =====
  const seek = (t: number) => setTime(Math.max(0, Math.min(duration, t)));
  const toggle = () => setPlaying((p) => !p);

  const addSegment = (seg: Omit<Segment, "id" | "layer">) => {
    setSegments((prev) => {
      const layer = findFreeLayer(prev, seg.start, seg.srcEnd - seg.srcStart);
      return [...prev, { ...seg, id: uid(), layer }];
    });
  };

  const splitAtPlayhead = () => {
    const sel = segments.find((s) => s.id === selectedId);
    if (!sel) return toast.error("Selecione um clip");
    const local = time - sel.start;
    if (local <= 0.05 || local >= lenOf(sel) - 0.05) return toast.error("Posicione o cursor dentro do clip");
    const splitSrc = sel.srcStart + local;
    const a: Segment = { ...sel, id: uid(), srcEnd: splitSrc };
    const b: Segment = { ...sel, id: uid(), srcStart: splitSrc, start: sel.start + local };
    setSegments((prev) => prev.flatMap((s) => (s.id === sel.id ? [a, b] : [s])));
    setSelectedId(b.id);
    toast.success("Clip dividido");
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setSegments((prev) => prev.filter((s) => s.id !== selectedId));
    setSelectedId(null);
  };

  /** Trim by source delta. Prevents overlap with same-layer neighbours by clamping. */
  const trim = (id: string, edge: "start" | "end", deltaSec: number) => {
    setSegments((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      const sameLayer = prev.filter((x) => x.id !== id && x.layer === s.layer);
      if (edge === "start") {
        const minSrc = Math.max(0, s.srcStart - (s.start)); // cannot push start before 0
        let newSrcStart = Math.max(0, Math.min(s.srcEnd - 0.1, s.srcStart + deltaSec));
        let newStart = s.start + (newSrcStart - s.srcStart);
        // prevent overlap with previous
        const prevSeg = sameLayer.filter((x) => endOf(x) <= s.start + 1e-3).sort((a, b) => endOf(b) - endOf(a))[0];
        if (prevSeg && newStart < endOf(prevSeg)) {
          const diff = endOf(prevSeg) - newStart;
          newStart += diff; newSrcStart += diff;
          if (newSrcStart >= s.srcEnd) return s;
        }
        return { ...s, srcStart: newSrcStart, start: newStart };
      } else {
        let newSrcEnd = Math.max(s.srcStart + 0.1, s.srcEnd + deltaSec);
        const newEnd = s.start + (newSrcEnd - s.srcStart);
        const nextSeg = sameLayer.filter((x) => x.start >= endOf(s) - 1e-3).sort((a, b) => a.start - b.start)[0];
        if (nextSeg && newEnd > nextSeg.start) {
          newSrcEnd = s.srcStart + (nextSeg.start - s.start);
          if (newSrcEnd <= s.srcStart) return s;
        }
        return { ...s, srcEnd: newSrcEnd };
      }
    }));
  };

  /** Move a segment to a new (start, layer). If conflict on target layer, find free layer below. */
  const moveSegment = (id: string, newStart: number, targetLayer: number) => {
    setSegments((prev) => {
      const seg = prev.find((s) => s.id === id);
      if (!seg) return prev;
      const ns = Math.max(0, newStart);
      const len = lenOf(seg);
      // Try targetLayer first; if conflict, walk down
      let layer = targetLayer;
      const conflict = (L: number) =>
        prev.some((s) => s.id !== id && s.layer === L && overlaps({ start: ns, end: ns + len }, { start: s.start, end: endOf(s) }));
      while (conflict(layer)) layer++;
      return prev.map((s) => (s.id === id ? { ...s, start: ns, layer } : s));
    });
  };

  const onUploadMedia = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const url = URL.createObjectURL(f);
      const isVideo = f.type.startsWith("video/");
      const isAudio = f.type.startsWith("audio/");
      let dur = 5;
      if (isVideo || isAudio) {
        dur = await new Promise<number>((res) => {
          const el = document.createElement(isVideo ? "video" : "audio") as HTMLMediaElement;
          el.preload = "metadata"; el.src = url;
          el.onloadedmetadata = () => res(el.duration || 5);
          el.onerror = () => res(5);
        });
      }
      const kind: Kind = isAudio ? "audio" : isVideo ? "video" : "image";
      addSegment({ kind, start: time, srcStart: 0, srcEnd: dur, label: f.name, mediaUrl: url });
    }
    toast.success("Mídia adicionada");
  };

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const PX_PER_SEC = 40 * zoom;
  const trackPxWidth = Math.max(duration * PX_PER_SEC, 600);
  const ticks = Math.max(10, Math.ceil(duration));

  const onRulerMouseDown = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const scroll = timelineScrollRef.current?.scrollLeft ?? 0;
    const fromX = (cx: number) => seek((cx - rect.left + scroll) / PX_PER_SEC);
    fromX(e.clientX);
    const move = (ev: MouseEvent) => fromX(ev.clientX);
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // chapters: derive from slide segments sorted by start
  const chapters = segments
    .filter((s) => s.kind === "slide")
    .sort((a, b) => a.start - b.start)
    .map((s) => ({ slideId: s.id, time: s.start, end: endOf(s), slide: { name: s.label } }));

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-background">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <button onClick={() => setView("home")} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <ArrowLeft className="h-4 w-4" /> Voltar
          </button>
          <button onClick={() => setChaptersOpen(true)} className="flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm ring-1 ring-border hover:bg-muted">
            <List className="h-4 w-4" /> Capítulos
          </button>
          <button onClick={() => setView("record")} className="flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm ring-1 ring-border hover:bg-muted">
            <Video className="h-4 w-4" /> Gravar nova cena
          </button>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-sm ring-1 ring-border hover:bg-muted">
            <Upload className="h-4 w-4" /> Mídia
            <input type="file" accept="image/*,video/*,audio/*" multiple className="hidden" onChange={(e) => onUploadMedia(e.target.files)} />
          </label>
        </div>
        <button onClick={() => toast.success("Projeto salvo")} className="flex items-center gap-1.5 rounded-md bg-[hsl(var(--rec))] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
          <Save className="h-4 w-4" /> Salvar
        </button>
      </header>

      {chaptersOpen && <ChaptersPanel onClose={() => setChaptersOpen(false)} segments={chapters} onSeek={seek} />}

      {/* Preview */}
      <div className="flex flex-1 items-stretch justify-center gap-6 px-6 pb-4 pt-4">
        {mainVideo && (
          <div className="relative aspect-video h-full max-h-[420px] overflow-hidden rounded-xl border-2 border-primary shadow-2xl bg-black">
            <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" muted />
            <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded bg-black/70 px-2 py-0.5 text-[11px] font-semibold text-white">
              <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--rec))] animate-pulse" /> WEBCAM
            </div>
          </div>
        )}
        <div className="relative flex h-full max-h-[420px] flex-1 items-center justify-center rounded-2xl bg-[hsl(var(--slide-bg))] p-4 ring-1 ring-white/5 overflow-hidden">
          {mainSlide?.slideUrl ? (
            <img src={mainSlide.slideUrl} alt="slide" className="max-h-full max-w-full rounded-lg object-contain" />
          ) : mainSlide && overlayImages.length === 0 ? (
            <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
              <ImageIcon className="h-10 w-10 opacity-40" />
              <div className="text-sm">Slide em branco</div>
              <div className="text-xs opacity-70">Use “Mídia” ou “Gravar nova cena” para começar</div>
            </div>
          ) : !mainSlide && overlayImages.length === 0 ? (
            <div className="text-muted-foreground text-sm">Sem slide ativo</div>
          ) : null}
          {overlayImages.map((o) => (
            <img
              key={o.id}
              src={o.mediaUrl}
              alt={o.label}
              className="pointer-events-none absolute inset-0 h-full w-full rounded-lg object-contain"
            />
          ))}
        </div>
      </div>

      {/* hidden audio elements */}
      {segments.filter((s) => s.kind === "audio").map((s) => (
        <audio key={s.id} ref={(el) => { audioRefs.current[s.id] = el; }} src={s.mediaUrl} preload="metadata" />
      ))}

      {/* player bar */}
      <div className="px-6">
        <div className="relative h-1 w-full cursor-pointer rounded-full bg-muted" onMouseDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const fromX = (cx: number) => seek(((cx - r.left) / r.width) * duration);
          fromX(e.clientX);
          const move = (ev: MouseEvent) => fromX(ev.clientX);
          const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }}>
          <div className="absolute left-0 top-0 h-1 rounded-full bg-[hsl(var(--rec))]" style={{ width: `${(time / duration) * 100}%` }} />
          <div className="absolute -top-1 h-3 w-3 -translate-x-1/2 rounded-full bg-[hsl(var(--rec))]" style={{ left: `${(time / duration) * 100}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button onClick={() => seek(0)} className="rounded-full p-1.5 hover:bg-muted"><SkipBack className="h-4 w-4" /></button>
            <button onClick={toggle} className="rounded-full bg-primary p-1.5 text-primary-foreground hover:bg-primary/90">
              {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
            </button>
            <button onClick={() => seek(duration)} className="rounded-full p-1.5 hover:bg-muted"><SkipForward className="h-4 w-4" /></button>
          </div>
          <div className="text-xs text-muted-foreground">{mainSlide?.label ?? "—"}</div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Volume2 className="h-4 w-4" />
            <Maximize2 className="h-4 w-4" />
            <span className="font-mono tabular-nums">{fmt(time)} / {fmt(duration)}</span>
          </div>
        </div>
      </div>

      {/* edit toolbar */}
      <div className="mt-2 flex items-center gap-2 px-4">
        <button onClick={splitAtPlayhead} disabled={!selectedId} className="flex items-center gap-1.5 rounded-md bg-card px-2.5 py-1.5 text-xs ring-1 ring-border hover:bg-muted disabled:opacity-40">
          <Scissors className="h-3.5 w-3.5" /> Dividir
        </button>
        <button onClick={deleteSelected} disabled={!selectedId} className="flex items-center gap-1.5 rounded-md bg-card px-2.5 py-1.5 text-xs ring-1 ring-border hover:bg-muted disabled:opacity-40">
          <Trash2 className="h-3.5 w-3.5" /> Apagar
        </button>
        <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <button onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))} className="rounded-md px-2 py-1 hover:bg-muted">−</button>
          Zoom {Math.round(zoom * 100)}%
          <button onClick={() => setZoom((z) => Math.min(4, z + 0.2))} className="rounded-md px-2 py-1 hover:bg-muted">+</button>
        </div>
      </div>

      {/* Timeline */}
      <div ref={timelineScrollRef} className="mt-2 flex-1 overflow-auto bg-[hsl(var(--timeline-bg))] px-2 pb-4 scrollbar-thin">
        <div className="relative" style={{ width: trackPxWidth + 80 }}>
          <div className="flex">
            <div className="w-20 shrink-0" />
            <div onMouseDown={onRulerMouseDown} className="relative cursor-pointer select-none border-b border-border/60 text-[10px] text-muted-foreground" style={{ width: trackPxWidth }}>
              <div className="flex">
                {Array.from({ length: ticks }).map((_, i) => (
                  <div key={i} style={{ width: PX_PER_SEC }} className="border-l border-border/40 px-1 py-1">{fmt(i)}</div>
                ))}
              </div>
            </div>
          </div>

          {Array.from({ length: layerCount }).map((_, layerIdx) => (
            <LayerRow
              key={layerIdx}
              layerIdx={layerIdx}
              segs={segments.filter((s) => s.layer === layerIdx)}
              pxPerSec={PX_PER_SEC}
              totalPx={trackPxWidth}
              selectedId={selectedId}
              setSelectedId={setSelectedId}
              trim={trim}
              moveSegment={moveSegment}
            />
          ))}

          {/* playhead */}
          <div
            className="absolute top-0 bottom-0 w-px cursor-grab active:cursor-grabbing bg-[hsl(var(--rec))]"
            style={{ left: 80 + time * PX_PER_SEC }}
            onMouseDown={(e) => {
              e.preventDefault();
              const scrollEl = timelineScrollRef.current;
              const startScroll = scrollEl?.scrollLeft ?? 0;
              const startX = e.clientX;
              const startTime = time;
              const move = (ev: MouseEvent) => {
                const dx = ev.clientX - startX + ((scrollEl?.scrollLeft ?? 0) - startScroll);
                seek(startTime + dx / PX_PER_SEC);
              };
              const up = () => {
                window.removeEventListener("mousemove", move);
                window.removeEventListener("mouseup", up);
              };
              window.addEventListener("mousemove", move);
              window.addEventListener("mouseup", up);
            }}
          >
            <div className="absolute -top-1 -left-[5px] h-2.5 w-2.5 rotate-45 cursor-grab active:cursor-grabbing bg-[hsl(var(--rec))]" />
          </div>
        </div>
      </div>
    </div>
  );
}

const KIND_STYLE: Record<Kind, { color: string; Icon: any }> = {
  video: { color: "bg-primary/30 ring-primary/60", Icon: Video },
  slide: { color: "bg-emerald-500/30 ring-emerald-500/60", Icon: ImageIcon },
  audio: { color: "bg-fuchsia-500/25 ring-fuchsia-500/50", Icon: Music },
  image: { color: "bg-amber-500/30 ring-amber-500/60", Icon: Film },
};

function LayerRow({ layerIdx, segs, pxPerSec, totalPx, selectedId, setSelectedId, trim, moveSegment }: {
  layerIdx: number;
  segs: Segment[];
  pxPerSec: number;
  totalPx: number;
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  trim: (id: string, edge: "start" | "end", deltaSec: number) => void;
  moveSegment: (id: string, newStart: number, targetLayer: number) => void;
}) {
  return (
    <div className="flex items-stretch">
      <div className="flex w-20 shrink-0 items-center gap-1.5 py-2 text-xs text-muted-foreground">
        <Plus className="h-3 w-3 opacity-50" /> Camada {layerIdx + 1}
      </div>
      <div
        className="relative my-1 h-9 rounded bg-[hsl(var(--track-bg))] ring-1 ring-border/50"
        style={{ width: totalPx }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("text/seg-id")) e.preventDefault(); }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData("text/seg-id");
          if (!id) return;
          const offset = parseFloat(e.dataTransfer.getData("text/offset-sec") || "0");
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const x = e.clientX - rect.left;
          const newStart = Math.max(0, x / pxPerSec - offset);
          moveSegment(id, newStart, layerIdx);
        }}
      >
        {segs.map((s) => {
          const left = s.start * pxPerSec;
          const width = (s.srcEnd - s.srcStart) * pxPerSec;
          const selected = selectedId === s.id;
          const style = KIND_STYLE[s.kind];
          return (
            <div
              key={s.id}
              draggable
              onDragStart={(e) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const offsetSec = (e.clientX - rect.left) / pxPerSec;
                e.dataTransfer.setData("text/seg-id", s.id);
                e.dataTransfer.setData("text/offset-sec", String(offsetSec));
                e.dataTransfer.effectAllowed = "move";
              }}
              onMouseDown={(e) => { if ((e.target as HTMLElement).dataset.handle) return; setSelectedId(s.id); }}
              className={`group absolute inset-y-0.5 cursor-grab overflow-hidden rounded ring-1 ${style.color} ${selected ? "outline outline-2 outline-[hsl(var(--rec))]" : ""}`}
              style={{ left, width }}
            >
              <div className="flex h-full items-center gap-1 px-1.5 text-[10px] text-foreground/90">
                <style.Icon className="h-3 w-3 opacity-70" />
                <span className="truncate">{s.label}</span>
              </div>
              <Handle onDrag={(d) => trim(s.id, "start", d / pxPerSec)} side="left" />
              <Handle onDrag={(d) => trim(s.id, "end", d / pxPerSec)} side="right" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Handle({ side, onDrag }: { side: "left" | "right"; onDrag: (deltaPx: number) => void }) {
  const onDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    let last = e.clientX;
    const move = (ev: MouseEvent) => { const d = ev.clientX - last; last = ev.clientX; onDrag(d); };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return (
    <div data-handle="1" onMouseDown={onDown}
      className={`absolute inset-y-0 w-1.5 cursor-ew-resize bg-foreground/40 opacity-0 transition group-hover:opacity-100 ${side === "left" ? "left-0" : "right-0"}`} />
  );
}
