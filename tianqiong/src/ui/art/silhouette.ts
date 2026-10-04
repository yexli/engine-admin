/* ============================================================
   程序化剪影层（缺绘卷地点的「地平线」）
   ------------------------------------------------------------
   63 个地点只有 2 张绘卷，缺图是常态；光场渐变只有颜色没有轮廓，
   看起来像「图没加载」而不是「一个地方」。这一层按地点类型生成
   两层剪影 SVG（远层略亮、近层更沉），垫在光场之上、绘卷之下：
   有绘卷时被盖住（交叉淡入的空档它也在场，换景不再闪黑）。

   颜色从地点自己的 color 调出：剪影只借它的色相，明度压到近黑，
   与 #0b0f1d 的舞台底色相接。类型由**地点名优先、area 兜底**判定
   （地点名比地区名更具体：「城外旷野」属于「圣辉城」却是旷野）。
   ============================================================ */

export type SilKind = 'city' | 'mountain' | 'forest' | 'cave' | 'desert' | 'hills';

/** 两个 hex 颜色按 t 插值（t=0 得 a，t=1 得 b）——剪影色调的唯一算法 */
export function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/**
 * 类型判定：地点名命中就用它（洞窟/山/林/沙/原/城郭各归各类），
 * 地点名没有特征词才看地区名，再没有就落丘陵（自然轮廓最不易穿帮）。
 */
export function silKindOf(name: string, area: string): SilKind {
  const t = (kw: RegExp, s: string) => kw.test(s);
  if (t(/洞|窟|渊|墓|陵|核|府|墟/, name)) return 'cave';
  if (t(/山|峰|岭|崖|脊|门/, name)) return 'mountain';
  if (t(/林|森/, name)) return 'forest';
  if (t(/沙|漠|丘|绿洲/, name)) return 'desert';
  if (t(/原|野/, name)) return 'hills';
  if (t(/城|街|巷|市|殿|宫|区|会|馆|塔|堡|工坊|栈|港|帐|庭|台|坛/, name)) return 'city';
  if (t(/山脉/, area)) return 'mountain';
  if (t(/绿洲|沙|漠/, area)) return 'desert';
  if (t(/渊|洞/, area)) return 'cave';
  if (t(/原|岛|之地|归处|之外|之庭|遗迹/, area)) return 'hills';
  return 'city';
}

/* ---- 轮廓：连绵山形用程序生成，其余手写 path（viewBox 统一 1440×300）---- */
const ridge = (y: number, amp: number, n: number): string => {
  let d = 'M0 300 V' + y;
  const w = 1440 / n;
  for (let i = 0; i < n; i++) {
    const x0 = Math.round(w * i);
    const x1 = Math.round(w * (i + 1));
    /* 二次曲线的中点只到控制点一半高，控制点给 2 倍振幅才是想要的起伏 */
    d += ' Q ' + Math.round((x0 + x1) / 2) + ' ' + (y - amp * 2) + ' ' + x1 + ' ' + (y + (i % 2 ? 6 : -4));
  }
  return d + ' L1440 300 Z';
};

const PATHS: Record<SilKind, { h: number; far: string; near: string }> = {
  /* 城郭：两层屋顶线，远层带一座钟塔尖（对应圣钟塔的意象） */
  city: {
    h: 300,
    far:
      'M0 300 V196 H64 V176 H96 V196 H140 V158 H196 V196 H244 V140 L258 118 L272 140 V196 H330 V178 H402 V196 ' +
      'H452 V150 H512 V196 H560 V170 H612 L622 144 L632 170 H676 V196 H744 V162 H806 V196 H862 V146 H922 V196 ' +
      'H984 V174 H1046 V196 H1104 V154 H1168 V196 H1226 V180 H1296 V196 H1352 V162 H1440 V300 Z',
    near:
      'M0 300 V248 H84 V222 H150 V248 H218 V204 H288 V248 H352 V216 H420 L434 192 L448 216 V248 H524 V226 ' +
      'H600 V248 H668 V198 H744 V248 H812 V224 H886 V248 H958 V204 H1030 V248 H1102 V228 H1178 V248 H1250 V210 ' +
      'H1326 V248 H1394 V226 H1440 V300 Z',
  },
  mountain: {
    h: 300,
    far:
      'M0 300 V168 L96 96 L168 142 L252 62 L342 132 L424 88 L498 128 L586 52 L676 122 L756 82 L842 136 ' +
      'L926 72 L1008 126 L1096 58 L1186 116 L1264 86 L1344 132 L1440 92 V300 Z',
    near:
      'M0 300 V236 L86 192 L162 228 L254 172 L346 224 L438 188 L528 232 L618 176 L708 222 L798 184 L890 230 ' +
      'L982 190 L1072 232 L1162 182 L1252 222 L1342 194 L1440 228 V300 Z',
  },
  forest: { h: 300, far: ridge(196, 30, 22), near: ridge(244, 24, 17) },
  hills: { h: 300, far: ridge(178, 40, 7), near: ridge(232, 32, 5) },
  desert: {
    h: 300,
    far: 'M0 300 V206 C180 178 320 232 520 210 C700 190 840 238 1040 214 C1220 192 1340 232 1440 212 V300 Z',
    near: 'M0 300 V248 C220 222 380 268 600 246 C820 224 980 268 1180 248 C1300 236 1390 252 1440 246 V300 Z',
  },
  /* 洞窟：嶙峋碎石，比山更碎、更贴地 */
  cave: {
    h: 300,
    far:
      'M0 300 V176 L64 214 L118 152 L176 208 L238 140 L302 202 L368 154 L432 216 L498 146 L562 206 L628 162 ' +
      'L694 222 L758 148 L822 208 L888 166 L952 224 L1018 152 L1082 210 L1148 170 L1212 224 L1276 158 L1340 212 ' +
      'L1396 178 L1440 206 V300 Z',
    near:
      'M0 300 V238 L74 262 L142 216 L212 258 L284 208 L352 252 L424 214 L496 260 L568 212 L638 254 L710 218 ' +
      'L782 262 L854 214 L924 256 L996 220 L1068 260 L1140 216 L1210 256 L1282 222 L1352 258 L1440 228 V300 Z',
  },
};

/** 远层借地点色相但混入夜蓝，近层压到近黑——两层之间才有纵深 */
const FAR_TINT = '#141d33';
const NEAR_TINT = '#080c16';

const svgOf = (kind: SilKind, color: string): string => {
  const p = PATHS[kind];
  const far = mixHex(color, FAR_TINT, 0.44);
  const near = mixHex(color, NEAR_TINT, 0.7);
  const body =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1440 300' preserveAspectRatio='none'>" +
    "<path d='" + p.far + "' fill='" + far + "'/>" +
    "<path d='" + p.near + "' fill='" + near + "'/></svg>";
  /* React 的 backgroundImage 要的是完整 CSS 值：必须是 url("…") 包好的——
     裸 data URI 会被浏览器当无效值丢弃（实测踩到：.sil 渲染了却没背景）。
     单引号在双引号 url() 里安全（encodeURIComponent 不转义它，正好）。 */
  return 'url("data:image/svg+xml;utf8,' + encodeURIComponent(body) + '")';
};

export interface Silhouette {
  image: string;
  /** 剪影容器高（占舞台高度比）——山最高、沙丘最矮 */
  height: string;
}

const SIL_H: Record<SilKind, string> = {
  city: '30%',
  mountain: '44%',
  forest: '32%',
  cave: '38%',
  desert: '28%',
  hills: '32%',
};

const cache = new Map<string, Silhouette>();

/** 某地点的剪影（按 loc+color 缓存——同一地点反复换页不重新编码 SVG） */
export function silhouetteFor(loc: string, name: string, area: string, color: string): Silhouette {
  const key = loc + '|' + color;
  let sil = cache.get(key);
  if (!sil) {
    const kind = silKindOf(name, area);
    sil = { image: svgOf(kind, color), height: SIL_H[kind] };
    cache.set(key, sil);
  }
  return sil;
}
