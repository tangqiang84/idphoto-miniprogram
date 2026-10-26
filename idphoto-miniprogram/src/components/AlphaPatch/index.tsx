import { View, Text, Canvas, Slider, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';

interface Stroke {
  mode: 'erase' | 'restore';
  radius: number; // 归一化（相对短边）
  points: { x: number; y: number }[]; // 归一化 [0,1]
}

interface Props {
  /** 已合成底色的工作画布预览图（temp file），作为修补底图 */
  workPreviewPath: string;
  workW: number;
  workH: number;
  /** 完成：返回用户累积的全部笔画（归一化） */
  onApply: (strokes: Stroke[]) => void;
  onCancel: () => void;
}

const DISP_W = 320;

/**
 * 手动修补面板（PRD B1 / T1-17，任务 #42）
 * - 底图 = 合成底色后的工作画布（用户能看清抠图边缘在哪）。
 * - 两种笔刷：去除（红，置 alpha=0）/ 恢复（绿，置 alpha=1）。
 * - 触控在画布上拖动 = 累积笔画（归一化坐标），叠加半透明提示层即时反馈。
 * - 撤销 / 重置 / 完成修补（把笔画交回父组件对 alpha 重合成）。
 *
 * 注意：触控坐标与 canvas 绘制需真机验证（沙箱无 canvas/触控）；核心算法见 core/alphaPatch.js（Node 单测覆盖）。
 */
export default function AlphaPatch({ workPreviewPath, workW, workH, onApply, onCancel }: Props) {
  const dispH = Math.max(120, Math.round((DISP_W * workH) / workW));
  const canvasId = 'patchCanvas';
  const canvasRef = useRef<any>(null);
  const ctxRef = useRef<any>(null);
  const bgImgRef = useRef<any>(null);
  const drawingRef = useRef(false);
  const lastNormRef = useRef<{ x: number; y: number } | null>(null);

  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [mode, setMode] = useState<'erase' | 'restore'>('erase');
  const [radius, setRadius] = useState(0.04);

  // 初始化 canvas 节点 + 加载底图
  useEffect(() => {
    const q = Taro.createSelectorQuery();
    q.select('#' + canvasId)
      .fields({ node: true, size: true })
      .exec((res: any) => {
        if (!res || !res[0] || !res[0].node) return;
        const cv = res[0].node;
        const dpr = (Taro.getSystemInfoSync() as any).pixelRatio || 2;
        cv.width = DISP_W * dpr;
        cv.height = dispH * dpr;
        const ctx = cv.getContext('2d');
        ctx.scale(dpr, dpr);
        canvasRef.current = cv;
        ctxRef.current = ctx;

        const im = cv.createImage();
        im.onload = () => {
          bgImgRef.current = im;
          redraw();
        };
        im.onerror = () => console.warn('[AlphaPatch] 底图加载失败');
        im.src = workPreviewPath;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 重绘：底图 + 所有笔画提示层
  function redraw() {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.clearRect(0, 0, DISP_W, dispH);
    if (bgImgRef.current) {
      ctx.drawImage(bgImgRef.current, 0, 0, DISP_W, dispH);
    }
    for (const s of strokes) {
      const color = s.mode === 'erase' ? 'rgba(230,40,40,0.55)' : 'rgba(40,180,90,0.55)';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(3, s.radius * Math.min(DISP_W, dispH));
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (s.points.length === 1) {
        const p = s.points[0];
        ctx.beginPath();
        ctx.arc(p.x * DISP_W, p.y * dispH, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(s.points[0].x * DISP_W, s.points[0].y * dispH);
        for (let i = 1; i < s.points.length; i++) {
          ctx.lineTo(s.points[i].x * DISP_W, s.points[i].y * dispH);
        }
        ctx.stroke();
      }
    }
  }

  // 笔画变化后重绘
  useEffect(() => {
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokes]);

  // 取触控点的归一化坐标（weapp canvas 触控事件提供 x/y，相对画布左上，单位 CSS px）
  function normOf(e: any): { x: number; y: number } | null {
    const t = e && e.touches && e.touches[0];
    if (!t) return null;
    const x = typeof t.x === 'number' ? t.x : (typeof t.pageX === 'number' ? t.pageX : null);
    const y = typeof t.y === 'number' ? t.y : (typeof t.pageY === 'number' ? t.pageY : null);
    if (x == null || y == null) return null;
    return {
      x: Math.min(1, Math.max(0, x / DISP_W)),
      y: Math.min(1, Math.max(0, y / dispH)),
    };
  }

  function onStart(e: any) {
    const p = normOf(e);
    if (!p) return;
    drawingRef.current = true;
    lastNormRef.current = p;
    const s: Stroke = { mode, radius, points: [p] };
    setStrokes((prev) => [...prev, s]);
  }

  function onMove(e: any) {
    if (!drawingRef.current) return;
    const p = normOf(e);
    if (!p) return;
    lastNormRef.current = p;
    // 追加到最新一条笔画（避免重渲染抖动：直接基于 setStrokes 末尾 push）
    setStrokes((prev) => {
      if (!prev.length) return prev;
      const next = prev.slice();
      const last = { ...next[next.length - 1], points: [...next[next.length - 1].points, p] };
      next[next.length - 1] = last;
      return next;
    });
  }

  function onEnd() {
    drawingRef.current = false;
    lastNormRef.current = null;
  }

  function undo() {
    setStrokes((prev) => (prev.length ? prev.slice(0, -1) : prev));
  }

  function reset() {
    setStrokes([]);
  }

  return (
    <View className='patch'>
      <Text className='patch__h'>手动修补边缘（低置信区域可自己涂改）</Text>
      <Text className='patch__hint'>
        在底图上拖动：<Text style={{ color: '#e62828' }}>红=去除</Text> /{' '}
        <Text style={{ color: '#28b45a' }}>绿=恢复</Text>；完成后重合成查看效果
      </Text>

      <Canvas
        type='2d'
        id={canvasId}
        style={{ width: DISP_W + 'px', height: dispH + 'px', border: '1px solid #ccc', borderRadius: '6px', background: '#000' }}
        onTouchStart={onStart}
        onTouchMove={onMove}
        onTouchEnd={onEnd}
      />

      <View style={{ display: 'flex', flexDirection: 'row', margin: '8px 0', alignItems: 'center' }}>
        <View
          onClick={() => setMode('erase')}
          style={{ padding: '6px 12px', borderRadius: '6px', marginRight: '8px', border: mode === 'erase' ? '2px solid #e62828' : '1px solid #ccc', background: mode === 'erase' ? '#fdeaea' : '#fff' }}
        >
          <Text style={{ color: '#e62828', fontSize: '13px' }}>去除</Text>
        </View>
        <View
          onClick={() => setMode('restore')}
          style={{ padding: '6px 12px', borderRadius: '6px', marginRight: '8px', border: mode === 'restore' ? '2px solid #28b45a' : '1px solid #ccc', background: mode === 'restore' ? '#e9f7ee' : '#fff' }}
        >
          <Text style={{ color: '#28b45a', fontSize: '13px' }}>恢复</Text>
        </View>
      </View>

      <View style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', margin: '6px 0' }}>
        <Text style={{ fontSize: '12px', width: '60px' }}>笔刷大小</Text>
        <Slider
          style={{ flex: 1 }}
          min={2}
          max={12}
          value={Math.round(radius * 100)}
          onChange={(e: any) => setRadius((e.detail.value || 4) / 100)}
        />
      </View>

      <View style={{ display: 'flex', flexDirection: 'row', margin: '8px 0' }}>
        <Button size='mini' onClick={undo} disabled={!strokes.length}>撤销</Button>
        <Button size='mini' onClick={reset} disabled={!strokes.length}>重置</Button>
        <Button size='mini' onClick={onCancel}>取消</Button>
        <Button size='mini' type='primary' onClick={() => onApply(strokes)} disabled={!strokes.length}>
          完成修补
        </Button>
      </View>
    </View>
  );
}
