import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Bingo Pachinko (mobile portrait)
 * - Top: standard generated bingo card (B I N G O)
 * - Bottom: simple 2D pachinko board (square) with >= 40 pegs
 * - Player drags ball left/right at the top to position, release to drop
 * - Ball bounces with simple physics, lighting pegs with bingo numbers on hit
 * - When the ball finishes (falls out the bottom), hit pegs are removed
 * - Any lit peg numbers that exist on the bingo card are auto-marked
 * - Auto-calls BINGO; player gets 5 balls
 *
 * Notes:
 * - Uses touch events for ball positioning (tap to start, move to position, release to drop).
 * - Physics is lightweight/arcade (no external physics engine).
 */

// ----------------------------- Bingo helpers -----------------------------

const COLS = [
  { label: "B", min: 1, max: 15 },
  { label: "I", min: 16, max: 30 },
  { label: "N", min: 31, max: 45 },
  { label: "G", min: 46, max: 60 },
  { label: "O", min: 61, max: 75 },
];

function sampleUniqueInts(min: number, max: number, count: number, used: Set<number>) {
  const out: number[] = [];
  let guard = 0;
  while (out.length < count && guard++ < 10_000) {
    const n = Math.floor(Math.random() * (max - min + 1)) + min;
    if (!used.has(n)) {
      used.add(n);
      out.push(n);
    }
  }
  return out;
}

function generateBingoCard() {
  const used = new Set<number>();
  const grid: (number | "FREE")[][] = Array.from({ length: 5 }, () => Array(5).fill(0));

  for (let c = 0; c < 5; c++) {
    const picks = sampleUniqueInts(COLS[c].min, COLS[c].max, 5, used);
    for (let r = 0; r < 5; r++) grid[r][c] = picks[r];
  }

  grid[2][2] = "FREE";
  return grid;
}

function cardNumberPool(card: (number | "FREE")[][]): number[] {
  const out: number[] = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const v = card[r][c];
      if (typeof v === "number") out.push(v);
    }
  }
  return out;
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

// ----------------------------- Pachinko helpers -----------------------------

type Peg = {
  id: string;
  x: number; // [0..1]
  y: number; // [0..1]
  removed: boolean;
  hit: boolean;
  num?: number; // assigned on first hit
};

type PBall = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dropping: boolean;
};

function generatePegs(count = 30): Peg[] {
  // Generate a jittered grid inside the square.
  // Avoid top spawn band and bottom drain area.
  // Use fewer columns for better spacing to prevent balls from getting stuck
  const cols = 6;
  const rows = Math.ceil(count / cols);
  const pegs: Peg[] = [];

  const left = 0.12;
  const right = 0.88;
  const top = 0.15;
  const bottom = 0.90;

  let idx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (idx >= count) break;

      const gx = left + (c / (cols - 1)) * (right - left);
      const gy = top + (r / (rows - 1)) * (bottom - top);

      // Stagger every other row more to create better flow paths
      const stagger = (r % 2) * (right - left) * 0.08;

      // Reduced jitter to prevent tight clusters that trap balls
      const jitterX = (Math.random() - 0.5) * 0.03;
      const jitterY = (Math.random() - 0.5) * 0.03;

      pegs.push({
        id: `peg-${idx}`,
        x: clamp(gx + stagger + jitterX, 0.12, 0.88),
        y: clamp(gy + jitterY, 0.15, 0.90),
        removed: false,
        hit: false,
      });

      idx++;
    }
  }

  return pegs;
}

function pickHitNumber(pool: number[], marked: Set<number>) {
  // Weighted to improve “matches”:
  // - Prefer unmarked card numbers
  // - Otherwise random 1..75
  const unmarked = pool.filter((n) => !marked.has(n));
  const roll = Math.random();
  if (unmarked.length > 0 && roll < 0.75) {
    return unmarked[Math.floor(Math.random() * unmarked.length)];
  }
  return Math.floor(Math.random() * 75) + 1;
}


// ----------------------------- Main Game -----------------------------

export default function BingoPachinkoGame() {
  const [card, setCard] = useState<(number | "FREE")[][]>(() => generateBingoCard());
  const [marked, setMarked] = useState<Set<number>>(() => new Set());
  const pool = useMemo(() => cardNumberPool(card), [card]);

  const initialPegs = useMemo(() => generatePegs(30), []);
  const [pegs, setPegs] = useState<Peg[]>(initialPegs);
  const [ballsLeft, setBallsLeft] = useState(5);

  const [ball, setBall] = useState<PBall>({ x: 0.5, y: 0.06, vx: 0, vy: 0, dropping: false });
  const hitPegIdsRef = useRef<Set<string>>(new Set());
  
  // Use refs for physics to avoid re-renders
  const ballRef = useRef<PBall>({ x: 0.5, y: 0.06, vx: 0, vy: 0, dropping: false });
  const pegsRef = useRef<Peg[]>(initialPegs);
  const poolRef = useRef<number[]>(pool);
  const markedRef = useRef<Set<number>>(marked);
  const animationFrameRef = useRef<number>();
  const lastUpdateRef = useRef(performance.now());
  
  // Touch handling for ball positioning
  const isPositioningRef = useRef(false);
  const touchStartXRef = useRef(0);
  const gameAreaRef = useRef<HTMLDivElement>(null);
  
  // Initialize refs
  useEffect(() => {
    ballRef.current = ball;
  }, [ball]);
  
  useEffect(() => {
    pegsRef.current = pegs;
  }, [pegs]);

  useEffect(() => {
    poolRef.current = pool;
  }, [pool]);

  useEffect(() => {
    markedRef.current = marked;
  }, [marked]);

  const boardRef = useRef<HTMLDivElement | null>(null);
  const boardRectRef = useRef({ w: 400, h: 250 }); // Start with reasonable defaults
  const [boardSize, setBoardSize] = useState({ w: 400, h: 250 });
  const [isPositioning, setIsPositioning] = useState(false);

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      // Use actual width and fixed 250px height
      const newSize = { w: r.width, h: 250 };
      boardRectRef.current = newSize;
      setBoardSize(newSize); // Update state for SVG viewBox
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const isMarked = (v: number | "FREE") => v === "FREE" || (typeof v === "number" && marked.has(v));

  const hasBingo = useMemo(() => {
    const lines: (Array<number | "FREE">)[] = [];
    for (let r = 0; r < 5; r++) lines.push(card[r]);
    for (let c = 0; c < 5; c++) lines.push([card[0][c], card[1][c], card[2][c], card[3][c], card[4][c]]);
    lines.push([card[0][0], card[1][1], card[2][2], card[3][3], card[4][4]]);
    lines.push([card[0][4], card[1][3], card[2][2], card[3][1], card[4][0]]);
    return lines.some((line) => line.every(isMarked));
  }, [card, marked]);

  const markNumber = (n: number) => {
    if (!pool.includes(n)) return;
    setMarked((prev) => {
      if (prev.has(n)) return prev;
      const next = new Set(prev);
      next.add(n);
      return next;
    });
  };

  const resetBoard = () => {
    const newPegs = generatePegs(30);
    setPegs(newPegs);
    const newBall = { x: 0.5, y: 0.06, vx: 0, vy: 0, dropping: false };
    setBall(newBall);
    ballRef.current = newBall;
    hitPegIdsRef.current = new Set();
  };

  const newGame = () => {
    setCard(generateBingoCard());
    setMarked(new Set());
    setBallsLeft(5);
    resetBoard();
  };


  // Optimized physics loop with integrated collision detection
  useEffect(() => {
    let frameCount = 0;
    let collisionCheckCounter = 0;
    
    const step = (now: number) => {
      const dt = Math.min(0.02, (now - lastUpdateRef.current) / 1000);
      lastUpdateRef.current = now;

      const b = ballRef.current;
      if (!b.dropping) {
        // End-of-drop cleanup
        if (b.y >= 1.05 && hitPegIdsRef.current.size > 0) {
          const hitIds = hitPegIdsRef.current;
          const hitNums: number[] = [];
          const currentPegs = pegsRef.current;

          const next = currentPegs.map((p) => {
            if (p.removed) return p;
            if (!hitIds.has(p.id)) return p;
            if (typeof p.num === "number") hitNums.push(p.num);
            return { ...p, removed: true };
          });

          hitNums.forEach((n) => markNumber(n));
          setPegs(next);
          hitPegIdsRef.current = new Set();
        }
        animationFrameRef.current = requestAnimationFrame(step);
        return;
      }

      const g = 1.55;
      const damp = 0.999;

      let vx = b.vx * Math.pow(damp, dt * 60);
      let vy = (b.vy + g * dt) * Math.pow(damp, dt * 60);

      let x = b.x + vx * dt;
      let y = b.y + vy * dt;

      // Wall collisions
      const rBall = 0.03;
      if (x < rBall) {
        x = rBall;
        vx *= -0.85;
      }
      if (x > 1 - rBall) {
        x = 1 - rBall;
        vx *= -0.85;
      }
      if (y < rBall) {
        y = rBall;
        vy *= -0.35;
      }

      // Peg collisions - check every frame
      const rPeg = 0.018;
      const rr = (rBall + rPeg) * (rBall + rPeg);
      const currentPegs = pegsRef.current;
      let closest: Peg | null = null;
      let bestDist = Infinity;
      const pegUpdates: { id: string; num: number }[] = [];

      for (const p of currentPegs) {
        if (p.removed) continue;

        const dx = x - p.x;
        const dy = y - p.y;
        const dist2 = dx * dx + dy * dy;

        // Check collision
        if (dist2 <= rr) {
          hitPegIdsRef.current.add(p.id);
          if (!p.hit) {
            const num = pickHitNumber(poolRef.current, markedRef.current);
            pegUpdates.push({ id: p.id, num });
          }
        }

        // Track closest for bounce
        if (dist2 < bestDist) {
          bestDist = dist2;
          closest = p;
        }
      }

      // Update pegs if collisions detected
      if (pegUpdates.length > 0) {
        setPegs((prev) => {
          const updateMap = new Map(pegUpdates.map((u) => [u.id, u.num]));
          return prev.map((p) => {
            const num = updateMap.get(p.id);
            return num !== undefined ? { ...p, hit: true, num } : p;
          });
        });
      }

      // Handle bounce with closest peg
      if (closest) {
        const dx = x - closest.x;
        const dy = y - closest.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = rBall + rPeg;
        if (dist < minDist) {
          const nx = dx / dist;
          const ny = dy / dist;
          const vdot = vx * nx + vy * ny;
          const bounce = 0.88;
          vx = vx - 2 * vdot * nx;
          vy = vy - 2 * vdot * ny;
          vx *= bounce;
          vy *= bounce;
          // Push ball away from peg
          x = clamp(x + nx * (minDist - dist) * 0.8, 0.03, 0.97);
          y = clamp(y + ny * (minDist - dist) * 0.8, 0.03, 1.1);
        }
      }

      // Drain condition
      if (y > 1.06) {
        ballRef.current = { ...b, x, y: 1.06, vx: 0, vy: 0, dropping: false };
        setBall(ballRef.current);
        animationFrameRef.current = requestAnimationFrame(step);
        return;
      }

      // Update ref with new position
      ballRef.current = { x, y, vx, vy, dropping: true };

      // Update state periodically for React to sync (every 3 frames = ~20fps state updates)
      frameCount++;
      if (frameCount % 3 === 0) {
        setBall({ ...ballRef.current });
      }

      // Update DOM directly for smooth 60fps animation
      const ballEl = document.querySelector('[data-ball="falling"]') as HTMLElement;
      const collisionEl = document.querySelector('[data-ball-collision]') as HTMLElement;
      if (ballEl) {
        const { w, h } = boardRectRef.current;
        ballEl.style.left = `${x * w - 12}px`;
        ballEl.style.top = `${y * h - 12}px`;
        if (collisionEl) {
          const rBall = w * 0.03;
          collisionEl.style.left = `${x * w - rBall}px`;
          collisionEl.style.top = `${y * h - rBall}px`;
        }
      }

      animationFrameRef.current = requestAnimationFrame(step);
    };

    animationFrameRef.current = requestAnimationFrame(step);
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [markNumber]);


  // Unified handlers for both touch and mouse events
  const handleStart = useCallback((clientX: number, target: HTMLElement) => {
    const b = ballRef.current;
    if (b.dropping || ballsLeft <= 0) {
      return;
    }
    
    const rect = target.getBoundingClientRect();
    const x = clientX - rect.left;
    
    isPositioningRef.current = true;
    touchStartXRef.current = x;
    setIsPositioning(true);
    
    // Set initial ball position based on touch/mouse (normalized to 0-1, then clamped)
    const normalizedX = clamp(x / rect.width, 0.06, 0.94);
    setBall((prev) => {
      if (prev.dropping) return prev;
      return { ...prev, x: normalizedX };
    });
  }, [ballsLeft]);

  const handleMove = useCallback((clientX: number, target: HTMLElement) => {
    if (!isPositioningRef.current) return;
    
    const b = ballRef.current;
    if (b.dropping || ballsLeft <= 0) {
      return;
    }
    
    const rect = target.getBoundingClientRect();
    const x = clientX - rect.left;
    
    // Update ball position based on horizontal movement
    const normalizedX = clamp(x / rect.width, 0.06, 0.94);
    setBall((prev) => {
      if (prev.dropping) return prev;
      return { ...prev, x: normalizedX };
    });
  }, [ballsLeft]);

  const handleEnd = useCallback(() => {
    if (!isPositioningRef.current) {
      setIsPositioning(false);
      return;
    }
    
    const b = ballRef.current;
    if (b.dropping || ballsLeft <= 0) {
      isPositioningRef.current = false;
      setIsPositioning(false);
      return;
    }
    
    isPositioningRef.current = false;
    setIsPositioning(false);
    
    // Release the ball
    hitPegIdsRef.current = new Set();
    setBallsLeft((n) => Math.max(0, n - 1));
    setBall((prev) => ({
      ...prev,
      y: 0.06,
      vx: (Math.random() - 0.5) * 0.18,
      vy: 0.02,
      dropping: true,
    }));
  }, [ballsLeft]);

  // Touch event handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    handleStart(touch.clientX, e.currentTarget as HTMLElement);
  }, [handleStart]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isPositioningRef.current) {
      e.preventDefault();
      return;
    }
    
    const touch = e.touches[0];
    if (!touch) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    handleMove(touch.clientX, e.currentTarget as HTMLElement);
  }, [handleMove]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    handleEnd();
  }, [handleEnd]);

  // Mouse event handlers (for desktop testing)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    handleStart(e.clientX, e.currentTarget as HTMLElement);
  }, [handleStart]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPositioningRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    handleMove(e.clientX, e.currentTarget as HTMLElement);
  }, [handleMove]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    handleEnd();
  }, [handleEnd]);

  // Global mouse handlers for drag outside element
  useEffect(() => {
    if (!isPositioning) return;

    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!isPositioningRef.current || !gameAreaRef.current) return;
      e.preventDefault();
      handleMove(e.clientX, gameAreaRef.current);
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
      e.preventDefault();
      handleEnd();
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isPositioning, handleMove, handleEnd]);

  // UI derived
  const remainingPegs = pegs.filter((p) => !p.removed).length;
  const hitThisBoard = pegs.filter((p) => p.hit && !p.removed).length;

  // Coordinate -> px
  const toPx = (x01: number, y01: number) => {
    const { w, h } = boardRectRef.current;
    return { x: x01 * w, y: y01 * h };
  };

  const ballPx = toPx(ball.x, ball.y);

  // Prevent scrolling on mobile while allowing drag interactions
  useEffect(() => {
    // Prevent pull-to-refresh and overscroll bounce - but allow game area touches
    const preventOverscroll = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      
      // Always allow touches on buttons
      if (target.closest('button')) {
        return;
      }
      
      // Allow touches on game area (starting area or peg board)
      if (target.closest('[data-game-area]') || gameAreaRef.current?.contains(target)) {
        return;
      }
      
      // Prevent scrolling elsewhere
      if (e.touches.length === 1) {
        e.preventDefault();
      }
    };

    // Prevent double-tap zoom
    let lastTouchEnd = 0;
    const preventDoubleTapZoom = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      
      // Allow on game area
      if (target.closest('[data-game-area]') || gameAreaRef.current?.contains(target)) {
        return;
      }
      
      const now = Date.now();
      if (now - lastTouchEnd <= 300) {
        e.preventDefault();
      }
      lastTouchEnd = now;
    };

    // Add event listeners
    document.addEventListener('touchmove', preventOverscroll, { passive: false });
    document.addEventListener('touchend', preventDoubleTapZoom, { passive: false });
    
    // Prevent body scroll
    const originalOverflow = document.body.style.overflow;
    const originalPosition = document.body.style.position;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';

    return () => {
      document.removeEventListener('touchmove', preventOverscroll);
      document.removeEventListener('touchend', preventDoubleTapZoom);
      document.body.style.overflow = originalOverflow;
      document.body.style.position = originalPosition;
      document.body.style.width = '';
    };
  }, []);

  return (
    <div className="h-[100svh] w-full bg-slate-950 text-white flex flex-col overflow-hidden touch-none" style={{ touchAction: 'none' }}>
      {/* Header */}
      <div className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div className="text-lg font-semibold tracking-tight">
          Bingo Pachinko <span className="text-xs opacity-60 font-normal">v0.0.1</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={resetBoard}
            className="rounded-xl bg-white/10 px-3 py-2 text-sm active:scale-[0.98]"
          >
            Reset Board
          </button>
          <button
            onClick={newGame}
            className="rounded-xl bg-white/10 px-3 py-2 text-sm active:scale-[0.98]"
          >
            New Game
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col gap-2 px-3 pb-4 overflow-hidden">
        {/* Bingo Card - Smaller */}
        <div className="rounded-2xl bg-white/5 p-1.5 shadow-xl shrink-0">
          <div className="flex items-center justify-between pb-2">
            <div className="text-sm font-medium opacity-90">Hit pegs to reveal numbers</div>
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold opacity-80">
                Balls: {ballsLeft}/5
              </div>
              <div className="text-xs opacity-70">Pegs: {remainingPegs}</div>
            </div>
          </div>

          <div className="w-full max-w-[238px] mx-auto grid grid-cols-5 gap-0.5">
            {COLS.map((c) => (
              <div
                key={c.label}
                className="text-center text-xs font-semibold opacity-80 rounded-xl bg-white/5 py-1"
              >
                {c.label}
              </div>
            ))}

            {card.flatMap((row, r) =>
              row.map((cell, c) => {
                const free = cell === "FREE";
                const on = free || (typeof cell === "number" && marked.has(cell));
                return (
                  <div
                    key={`${r}-${c}`}
                    className={`aspect-square rounded-2xl flex items-center justify-center text-sm font-bold shadow-inner ${
                      on ? "bg-emerald-400/20 ring-1 ring-emerald-300/40" : "bg-white/5"
                    }`}
                  >
                    <div className="flex flex-col items-center leading-none">
                      <div className="tabular-nums">{free ? "★" : cell}</div>
                      {free && (
                        <div className="mt-1 text-[10px] font-semibold opacity-80">
                          FREE
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Pachinko Game Area */}
        <div className="flex-1 flex flex-col gap-2 rounded-3xl bg-white/5 shadow-xl overflow-hidden relative w-full max-w-[400px] mx-auto">
          {/* Ball Starting Area */}
          <div 
            data-game-area
            className="h-16 w-full bg-white/5 border-b border-white/10 flex items-center justify-center relative"
            style={{ touchAction: 'none', userSelect: 'none' }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          >
            <div className="text-xs opacity-70 text-center px-4">
              {isPositioning ? "Move finger left/right to position" : "Tap to position ball"}
            </div>
            {!ball.dropping && (
              <div
                className="absolute h-6 w-6 rounded-full bg-white pointer-events-none"
                style={{
                  left: `${(ball.x - 0.06) / 0.88 * 100}%`,
                  transform: 'translateX(-50%)',
                  top: '50%',
                  marginTop: '-12px',
                  transition: isPositioning ? 'none' : 'left 0.1s ease-out',
                }}
              />
            )}
          </div>

          {/* Peg Board - Fixed Square */}
          <div 
            data-game-area
            ref={gameAreaRef}
            className="relative mx-auto w-full max-w-[400px] shrink-0"
            style={{ 
              height: '250px',
              touchAction: 'none',
              userSelect: 'none',
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          >
            <div className="absolute top-2 left-2 right-2 z-10 flex items-center justify-between">
              <div className="text-xs opacity-80">
                {ball.dropping ? `Dropping… (hits: ${hitThisBoard})` : ballsLeft > 0 ? "Tap to position & release to drop" : "Out of balls"}
              </div>
            </div>

            <div ref={boardRef} className="absolute inset-0" style={{ touchAction: 'none' }}>
            <svg
              className="absolute inset-0"
              viewBox={`0 0 ${boardSize.w} ${boardSize.h}`}
              preserveAspectRatio="xMidYMid meet"
            >
              {/* Pegs */}
              {pegs.map((p) => {
                if (p.removed) return null;
                const pt = toPx(p.x, p.y);
                const hit = p.hit;
                const r = 7;
                return (
                  <g key={p.id}>
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={r}
                      fill={hit ? "rgba(16,185,129,0.25)" : "rgba(255,255,255,0.16)"}
                      stroke={hit ? "rgba(16,185,129,0.55)" : "rgba(255,255,255,0.22)"}
                      strokeWidth={2}
                    />
                    {hit && typeof p.num === "number" ? (
                      <text
                        x={pt.x}
                        y={pt.y - 10}
                        textAnchor="middle"
                        fontSize={12}
                        fontWeight={800}
                        fill="rgba(255,255,255,0.9)"
                      >
                        {p.num}
                      </text>
                    ) : null}
                  </g>
                );
              })}

              {/* Drain line */}
              <line
                x1={0}
                y1={boardSize.h * 0.98}
                x2={boardSize.w}
                y2={boardSize.h * 0.98}
                stroke="rgba(255,255,255,0.10)"
                strokeWidth={2}
                strokeDasharray="10 10"
              />
            </svg>

            {/* Simulated falling ball (visual) */}
            {ball.dropping ? (
              <>
                {/* Physics collision radius indicator */}
                <div
                  data-ball-collision
                  className="absolute rounded-full border-2 border-white/30 pointer-events-none"
                  style={{ 
                    left: ballPx.x - (boardRectRef.current.w * 0.03), 
                    top: ballPx.y - (boardRectRef.current.w * 0.03),
                    width: boardRectRef.current.w * 0.06,
                    height: boardRectRef.current.w * 0.06,
                    transition: 'none',
                  }}
                />
                {/* Visual ball */}
                <div
                  data-ball="falling"
                  className="absolute h-6 w-6 rounded-full bg-white pointer-events-none"
                  style={{ 
                    left: ballPx.x - 12, 
                    top: ballPx.y - 12,
                    transition: 'none', // Disable CSS transitions for direct DOM updates
                  }}
                />
              </>
            ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Safe-area padding for iOS */}
      <div className="h-[env(safe-area-inset-bottom)]" />
    </div>
  );
}
