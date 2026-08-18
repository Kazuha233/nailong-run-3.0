/* ============================================================
   依神渲染模块（游戏 index.html 用 · 独立于模拟窗）
   ------------------------------------------------------------
   依赖：window.YISHEN_DATA（yishen-data.js 提供）
   姿态：'run'|'stand'|'jump'|'duck'（duck = 主人自定义「滑铲」，
         v3.2 实装：依神蹲姿 = 滑铲动作，角度来自 yishen-poses.js）
   ============================================================ */
/* PNG 图片缓存 */
const YISHEN_IMG_CACHE = {};
function yishenLoadImg(data){
  if (YISHEN_IMG_CACHE[data] || !data) return;
  const im = new Image();
  im.onload = () => { YISHEN_IMG_CACHE[data] = im; };
  im.src = data;
}
function bboxOf(shapes){
  let b = { minX:1e9, minY:1e9, maxX:-1e9, maxY:-1e9 };
  for (const sh of shapes){
    b.minX = Math.min(b.minX, sh.x - sh.w/2); b.maxX = Math.max(b.maxX, sh.x + sh.w/2);
    b.minY = Math.min(b.minY, sh.y - sh.h/2); b.maxY = Math.max(b.maxY, sh.y + sh.h/2);
  }
  if (b.minX === 1e9) return { minX:0, minY:0, maxX:1, maxY:1 };
  return b;
}
/* 旋转感知包围盒：考虑每个形状的 rot（旋转后 AABB 变大），用于贴地计算与碰撞箱 */
function bboxOfRot(shapes){
  let b = { minX:1e9, minY:1e9, maxX:-1e9, maxY:-1e9 };
  for (const sh of shapes){
    const r = (sh.rot||0) * Math.PI/180, ca = Math.abs(Math.cos(r)), sa = Math.abs(Math.sin(r));
    const hw = sh.w/2, hh = sh.h/2;
    const rw = hw*ca + hh*sa, rh = hw*sa + hh*ca;      // 旋转后半宽/半高（AABB）
    b.minX = Math.min(b.minX, sh.x - rw); b.maxX = Math.max(b.maxX, sh.x + rw);
    b.minY = Math.min(b.minY, sh.y - rh); b.maxY = Math.max(b.maxY, sh.y + rh);
  }
  if (b.minX === 1e9) return { minX:0, minY:0, maxX:1, maxY:1 };
  return b;
}
function drawOneShapeAt(ctx, sh){
  ctx.save();
  ctx.translate(sh.x, sh.y);
  ctx.rotate((sh.rot||0) * Math.PI/180);
  if (sh.type === 'rect'){ ctx.fillStyle = sh.c; ctx.fillRect(-sh.w/2, -sh.h/2, sh.w, sh.h); }
  else if (sh.type === 'ellipse'){ ctx.fillStyle = sh.c; ctx.beginPath(); ctx.ellipse(0, 0, sh.w/2, sh.h/2, 0, 0, Math.PI*2); ctx.fill(); }
  else if (sh.type === 'tri'){                        // 工坊同规则：默认等腰尖朝上，rt=直角（corner），flipV 尖朝下
    ctx.fillStyle = sh.c;
    ctx.beginPath();
    if (sh.variant === 'rt'){
      const c = sh.corner || 'br';
      const P = {
        bl: [[-sh.w/2,-sh.h/2],[-sh.w/2,sh.h/2],[sh.w/2,-sh.h/2]],
        br: [[-sh.w/2,-sh.h/2],[sh.w/2,-sh.h/2],[sh.w/2,sh.h/2]],
        tl: [[-sh.w/2,sh.h/2],[sh.w/2,sh.h/2],[-sh.w/2,-sh.h/2]],
        tr: [[-sh.w/2,sh.h/2],[sh.w/2,sh.h/2],[sh.w/2,-sh.h/2]],
      }[c];
      ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.lineTo(P[2][0], P[2][1]);
    } else {
      const fy = sh.flipV ? -1 : 1;
      ctx.moveTo(0, sh.h/2*fy); ctx.lineTo(sh.w/2, -sh.h/2*fy); ctx.lineTo(-sh.w/2, -sh.h/2*fy);
    }
    ctx.closePath(); ctx.fill();
  }
  else if (sh.type === 'line'){                       // 描边折线（pts 相对中心）
    ctx.strokeStyle = sh.c; ctx.lineWidth = sh.lineWidth || 2;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(sh.pts[0][0], sh.pts[0][1]);
    for (let i=1;i<sh.pts.length;i++) ctx.lineTo(sh.pts[i][0], sh.pts[i][1]);
    ctx.stroke();
  }
  else if (sh.type === 'img'){
    const im = YISHEN_IMG_CACHE[sh.data];
    if (im){
      if (sh.flipH || sh.flipV) ctx.scale(sh.flipH ? -1 : 1, sh.flipV ? -1 : 1);
      ctx.drawImage(im, -sh.w/2, -sh.h/2, sh.w, sh.h);
    } else { yishenLoadImg(sh.data); }
  }
  ctx.restore();
}
/* 连接点树：根=躯干 hub，旋转支点 = 子级上指向父级的连接点（世界坐标） */
function buildYishenTree(d){
  const shapes = d.shapes;
  const root = shapes.find(s => (s.note||'').includes('躯干'))
        || shapes.reduce((a,b)=>(((b.points||[]).length) > ((a.points||[]).length) ? b : a));
  const byId = {};
  const rootNode = { shape: root, parent: null, parentLink: null };
  byId[root.id] = rootNode;
  const queue = [rootNode];
  while (queue.length){
    const node = queue.shift();
    for (const p of (node.shape.points||[])){
      if (!p.link) continue;
      const child = shapes.find(x => x.id === p.link.shape);
      if (!child || byId[child.id]) continue;
      const link = (child.points||[]).find(cp => cp.link && cp.link.shape === node.shape.id) || p;
      const cnode = { shape: child, parent: node, parentLink: link };
      byId[child.id] = cnode;
      queue.push(cnode);
    }
  }
  return { root: rootNode, byId };
}
/* 部位角度（游戏版：duck=滑铲角度表；run 前倾大振幅；单向负角屈膝永不反关节） */
function yishenAngleForNode(node, mode, t, squatForce){
  if (!node || !node.parent) return 0;                 // 根（躯干）不转
  const sh = node.shape;
  const note = sh.note || '';
  const ph = note.includes('左') ? 0 : Math.PI;        // 左右反相
  const isThigh = note.includes('腿');
  const isFoot  = note.includes('脚');
  const isArm   = note.includes('手');
  const isHead  = note.includes('头');
  if (mode === 'duck'){
    // 缠荆棘(th_lv>0)/着火(onFire)=蹲（主人自定义动作）；无荆棘=滑铲
    if ((typeof th_lv !== 'undefined' && th_lv > 0) || !!squatForce){
      const SQUAT = { s2:-0.79, s4:-0.3, s7:0.03, s5:1.8, s8:2.31, s3:-2.76, s6:-2.13 };
      return SQUAT[sh.id] || 0;
    }
    const SLIDE = { s2:-0.37, s4:-2.53, s7:-0.22, s5:0.42, s8:0.41, s3:-0.26, s6:-2.23 };
    return SLIDE[sh.id] || 0;
  }
  if (mode === 'run'){
    if (isThigh) return Math.sin(t*13 + ph) * 0.8;
    if (isFoot)  return -(0.2 + Math.max(0, Math.sin(t*13 + ph)) * 1.0);   // 前摆屈膝/后摆伸直，恒负角
    if (isArm)   return Math.sin(t*13 + ph + Math.PI) * 0.85;
    if (isHead)  return Math.sin(t*13) * 0.14;
    return 0;
  }
  if (mode === 'jump'){
    // 主人自定义「跳跃」动作（2026-08-08 替换）：头0.09 手-0.32/-0.17 腿0.63/0.57 脚-1.37/-0.96，后仰12°
    const JUMP = { s2:0.09, s4:-0.32, s7:-0.17, s5:0.63, s8:0.57, s3:-1.37, s6:-0.96 };
    return JUMP[sh.id] || 0;
  }
  if (mode === 'fart'){
    // 喷气（主人自定义动作，放屁时姿态）：前倾 12° + 四肢收拢喷气状
    const FART = { s2:-0.29, s4:-0.9, s7:-1.41, s5:0.54, s8:-0.69, s3:-2.04, s6:-0.57 };
    return FART[sh.id] || 0;
  }
  return 0;                                            // stand
}
/* 姿态过渡（主人 8/8 定稿）：进入滑铲/蹲时 头(s2)/双手(s4,s7)/躯干(lean) 平滑 0.12s、腿脚瞬切；
   滑铲/蹲回跑步：全部部位整体平滑；跳跃切换瞬切 */
let yishenLastMode = null, yishenSwitchT = -1e9;
let yishenPrevAng = {}, yishenDisp = {}, yishenPrevBob = 0, yishenDispBob = 0, yishenPrevLean = 0, yishenDispLean = 0;
let yishenPrevLift = 0, yishenDispLift = 0, yishenFromDuck = false;
function yishenBlend(d, mode, t, squatForce){
  const tree = buildYishenTree(d);
  const target = {};
  for (const id in tree.byId) target[id] = yishenAngleForNode(tree.byId[id], mode, t, squatForce);
  const bobTarget = (mode === 'run') ? Math.sin(t*26)*2.5 : (mode === 'jump' ? -6 : 0);
  const rootSh = tree.root.shape;
  const squat = (typeof th_lv !== 'undefined' && th_lv > 0) || !!squatForce;
  const leanTarget = (mode === 'run') ? -0.18
    : (mode === 'jump') ? -12 * Math.PI/180
    : (mode === 'duck') ? (squat ? -35 * Math.PI/180 : -(-73) * Math.PI/180)
    : (mode === 'fart') ? -(-12) * Math.PI/180
    : 0;
  // 贴地补偿量（滑铲/蹲抬升、回跑步归零）——进入滑铲/蹲瞬切、回跑步平滑（防位置跳变）
  const liftTarget = (mode === 'duck') ? (squat ? YISHEN_SQUAT_LIFT : YISHEN_SLIDE_LIFT) : 0;
  const prevMode = yishenLastMode;
  if (mode !== prevMode){
    yishenLastMode = mode;
    yishenSwitchT = t;
    yishenFromDuck = (prevMode === 'duck') && (mode !== 'duck');   // 记录「从滑铲/蹲回来」标记，过渡期内保持
    yishenPrevAng = {};
    for (const id in tree.byId) yishenPrevAng[id] = (yishenDisp[id] !== undefined ? yishenDisp[id] : target[id]);
    yishenPrevBob = yishenDispBob; yishenPrevLean = yishenDispLean;
    yishenPrevLift = yishenDispLift;
  }
  const k = Math.min(1, Math.max(0, (t - yishenSwitchT) / 0.12));
  const kk = k*k*(3-2*k);
  const done = k >= 1;
  const inDuck = (mode === 'duck');                        // 进入滑铲/蹲
  const fromDuck = yishenFromDuck && !done;                // 滑铲/蹲回跑步（过渡期内保持）
  const UPPER = ['s2','s4','s7'];                          // 头 + 双手（进入滑铲/蹲时平滑的部位）
  for (const id in tree.byId){
    const blend = (inDuck && UPPER.includes(id)) || fromDuck;
    yishenDisp[id] = (done || !blend) ? target[id] : (yishenPrevAng[id] + (target[id] - yishenPrevAng[id]) * kk);
  }
  const leanBlend = (inDuck && squat) || fromDuck;   // 蹲进入躯干瞬切、滑铲过渡；回跑步过渡
  yishenDispLean = (done || !leanBlend) ? leanTarget : (yishenPrevLean + (leanTarget - yishenPrevLean) * kk);
  const bobBlend = inDuck || fromDuck;
  yishenDispBob = (done || !bobBlend) ? bobTarget : (yishenPrevBob + (bobTarget - yishenPrevBob) * kk);
  yishenDispLift = (done || !fromDuck) ? liftTarget : (yishenPrevLift + (liftTarget - yishenPrevLift) * kk);   // 回跑步 lift 平滑
  return { ang: yishenDisp, bob: yishenDispBob, lean: yishenDispLean, lift: yishenDispLift };
}
/* 绘制依神：cx/cy = 屏幕坐标（cy 传「脚底贴地」后的位置），s=缩放，mode=姿态，t=动画时间，squatForce=强制蹲（着火/缠荆棘） */
function drawYishen(ctx, cx, cy, s, mode, t, squatForce){
  const d = window.YISHEN_DATA;
  if (!d || !d.shapes || !d.shapes.length) return;
  const tree = buildYishenTree(d);
  const blend = yishenBlend(d, mode, t, squatForce);          // 姿态过渡插值（切换衔接）
  ctx.save();
  ctx.translate(cx, cy + blend.bob);
  ctx.scale(s, -s);
  const ang = blend.ang;
  const rootSh = tree.root.shape;
  const lean = blend.lean;
  const leanPivot = { x: rootSh.x, y: rootSh.y - rootSh.h/2 };
  for (const sh of d.shapes){
    ctx.save();
    ctx.translate(leanPivot.x, leanPivot.y);
    ctx.rotate(lean);
    ctx.translate(-leanPivot.x, -leanPivot.y);
    const chain = [];
    let n = tree.byId[sh.id];
    while (n && n.parent){ chain.push(n); n = n.parent; }
    chain.reverse();
    for (const cn of chain){
      const lp = cn.parentLink;
      const csh = cn.shape;
      const r = (csh.rot||0) * Math.PI/180, ca = Math.cos(r), sa = Math.sin(r);
      const wx = csh.x + lp.x*ca - lp.y*sa, wy = csh.y + lp.x*sa + lp.y*ca;
      ctx.translate(wx, wy);
      ctx.rotate(ang[csh.id]);
      ctx.translate(-wx, -wy);
    }
    drawOneShapeAt(ctx, sh);
    ctx.restore();
  }
  ctx.restore();
}
/* 依神整体缩放（游戏内与奶龙体型相近：0.42→0.48 主人要求放大一点） */
const YISHEN_SCALE = 0.48;
/* 整体位置微调（屏幕像素）：主人反馈「感觉腾空」→ 下移贴地（2026-08-08） */
const YISHEN_FOOT_OFFSET = 3;
/* 依神身上荆棘/细雪：数据版优先（工坊绘制，极限模式 SNOW_THORNS[L]，普通 YISHEN_THORNS[L]），缺省回退代码生成版
   ⚠️ thMode 必须显式传入（游戏主脚本 IIFE 内 mode 是局部变量，全局函数访问不到——曾导致极限模式永远画荆棘） */
function drawYishenThorn(ctx, cx, cy, s, poseMode, t, L, thMode, squatForce){
  if (L <= 0) return;
  const d = window.YISHEN_DATA;
  if (!d || !d.shapes || !d.shapes.length) return;
  const tree = buildYishenTree(d);
  const root = tree.root.shape;
  const blend = yishenBlend(d, poseMode, t, squatForce);          // 与角色同一插值状态（切换衔接同步）
  const bob = blend.bob;
  const lean = blend.lean;
  const pivot = { x: root.x, y: root.y - root.h/2 };
  ctx.save();
  ctx.translate(cx, cy + bob);
  ctx.scale(s, -s);
  ctx.translate(pivot.x, pivot.y);
  ctx.rotate(lean);
  ctx.translate(-pivot.x, -pivot.y);
  // —— 数据版（工坊绘制）：世界坐标直接画形状；极限模式用细雪（SNOW_THORNS），普通模式用荆棘（YISHEN_THORNS） ——
  // 荆棘/细雪均为 5 层完整数据（主人手绘）：直接按层索引，1/2 层（荆棘）缺数据时走代码版 fallback
  const isSnow = thMode === 'extreme';
  const thorns = isSnow
    ? (window.SNOW_THORNS && window.SNOW_THORNS[L])
    : (window.YISHEN_THORNS && window.YISHEN_THORNS[L]);
  if (thorns && thorns.length){
    if (isSnow){
      // 细雪：整体 1.8 倍（位置+大小等比）、向左上偏移（世界坐标 y 向上：x-90, y+200）
      ctx.save();
      ctx.translate(-15, 50);
      ctx.scale(1.2, 1.2);
      for (const sh of thorns){
        ctx.save();
        ctx.translate(sh.x, sh.y);
        ctx.rotate((sh.rot||0) * Math.PI/180);
        if (sh.type === 'ellipse'){ ctx.fillStyle = sh.c; ctx.beginPath(); ctx.ellipse(0, 0, sh.w/2, sh.h/2, 0, 0, Math.PI*2); ctx.fill(); }
        ctx.restore();
      }
      ctx.restore();
    } else {
      for (const sh of thorns) drawOneShapeAt(ctx, sh);
    }
    ctx.restore();
    return;
  }
  // —— 代码生成版（fallback） ——
  const cx0 = root.x, cy0 = root.y;                      // 躯干中心（世界坐标）
  const span = (L === 3) ? root.h*0.7 : root.h*0.5;      // 垂直缠绕范围（3层覆盖到头部）
  const spread = root.w*0.72;                            // 水平缠绕范围
  ctx.lineCap = 'round';
  // ===== 棕色主藤条：螺旋环绕 + 控制点交叉（错综缠绕感） =====
  ctx.strokeStyle = '#8B5A2B';
  ctx.lineWidth = 2.6/s;
  const branches = 3 + L*2 + (L===3 ? 3 : 0);            // 1层5 / 2层7 / 3层10
  for (let i=0;i<branches;i++){
    const t0 = i/Math.max(1,branches-1);
    const phase = t0*Math.PI*2 + (L%2)*0.6;              // 环绕相位（层数不同错开）
    const yOff = (t0-0.5)*span*1.7;                      // 每根高度错开
    const x0 = cx0 + Math.cos(phase)*spread*0.5;
    const y0 = cy0 + yOff + Math.sin(phase*1.7)*span*0.3;
    const xm1 = cx0 + Math.cos(phase+1.2)*spread*0.85, ym1 = cy0 + yOff + span*0.22;
    const xm2 = cx0 + Math.cos(phase+2.4)*spread*0.85, ym2 = cy0 + yOff - span*0.22;
    const x1 = cx0 + Math.cos(phase+Math.PI)*spread*0.45, y1 = cy0 + yOff - Math.sin(phase)*span*0.3;
    ctx.beginPath(); ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(xm1, ym1, xm2, ym2, x1, y1);       // 三次贝塞尔：S 形交叉缠绕
    ctx.stroke();
    // 分支小叉（交错方向）
    const mx = (x0+x1)/2, my = (y0+y1)/2;
    const dir = (i%2===0) ? 1 : -1;
    const bx = mx + dir*8/s + (i%3)*2/s, by = my - 6/s;
    ctx.lineWidth = 1.6/s;
    ctx.beginPath(); ctx.moveTo(mx, my);
    ctx.quadraticCurveTo(bx, by - 6/s, bx + dir*5/s, by - 14/s);
    ctx.stroke();
    ctx.lineWidth = 2.6/s;
  }
  // ===== 绿色纸条：乱相位交错插缠 =====
  ctx.strokeStyle = '#3E8E41';
  ctx.lineWidth = 2/s;
  const leaves = 4 + L*3 + (L===3 ? 4 : 0);              // 1层7 / 2层10 / 3层14
  for (let i=0;i<leaves;i++){
    const t0 = i/Math.max(1,leaves-1);
    const a = t0*Math.PI*2 + i*0.7;                      // 乱相位分布
    const lx = cx0 + Math.cos(a)*spread*0.7;
    const ly = cy0 + (t0-0.5)*span*1.4 + Math.sin(i*3.7)*span*0.35;
    const dir = (i%2===0) ? 1 : -1;
    const len = 6 + (i%3)*3;
    ctx.beginPath(); ctx.moveTo(lx, ly);
    ctx.quadraticCurveTo(lx + dir*len*0.5, ly - len*0.7, lx + dir*len, ly - len*1.2);
    ctx.stroke();
  }
  // ===== 浅绿尖刺：散乱分布（覆盖递增） =====
  ctx.fillStyle = '#A5D6A7';
  const spikes = 3 + L*3 + (L===3 ? 3 : 0);              // 1层6 / 2层9 / 3层12
  for (let i=0;i<spikes;i++){
    const t0 = i/Math.max(1,spikes-1);
    const a = t0*Math.PI*2 + i*1.3;
    const sx0 = cx0 + Math.cos(a)*spread*0.85;
    const sy0 = cy0 + (t0-0.5)*span*1.5 + Math.sin(i*2.9)*span*0.3;
    const sz = 2 + (i%3)*1.5;
    ctx.beginPath(); ctx.moveTo(sx0, sy0);
    ctx.lineTo(sx0 + sz*1.5, sy0 - sz*4);
    ctx.lineTo(sx0 + sz*3, sy0);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

/* 滑铲姿态实测（世界单位）：最低点比站姿 bbox 底高 57.6、渲染宽 231、高 109、x 中心偏移 75 */
const YISHEN_SLIDE_LIFT = 57.6;
const YISHEN_SLIDE_W = 231, YISHEN_SLIDE_H = 109, YISHEN_SLIDE_CX = 75;
/* 蹲（缠荆棘）姿态实测（世界单位）：最低点比站姿高 49.9（新蹲：大腿1.8/2.31+后仰35°）、渲染宽 133、高 123 */
const YISHEN_SQUAT_LIFT = 49.9, YISHEN_SQUAT_W = 133, YISHEN_SQUAT_H = 123;
function yishenHitbox(x, y, low, squatForce){
  y = y + YISHEN_FOOT_OFFSET;   // 与渲染整体下移同步（贴地）
  if (low){
    if ((typeof th_lv !== 'undefined' && th_lv > 0) || !!squatForce){
      // 蹲（缠荆棘时）：新蹲 64×59px 渲染（后仰35°）→ 内缩 52×52，中心≈站姿中心
      const b = bboxOfRot(window.YISHEN_DATA.shapes);
      const cx = x + (b.minX + b.maxX)/2 * YISHEN_SCALE;
      return { x1: cx - 26, y1: y - 52, x2: cx + 26, y2: y };
    }
    // 滑铲（无荆棘）：矮宽框，中心按滑铲渲染中心偏移
    const w = YISHEN_SLIDE_W * YISHEN_SCALE, h = YISHEN_SLIDE_H * YISHEN_SCALE;
    const cx = x + YISHEN_SLIDE_CX * YISHEN_SCALE;
    return { x1: cx - w*0.4, y1: y - h*0.85, x2: cx + w*0.4, y2: y };
  }
  const b = bboxOfRot(window.YISHEN_DATA.shapes);
  const w = (b.maxX - b.minX) * YISHEN_SCALE;      // 渲染宽（≈55px）
  const h = (b.maxY - b.minY) * YISHEN_SCALE;      // 渲染高（≈84px）
  const cx = x + (b.minX + b.maxX)/2 * YISHEN_SCALE;   // 渲染中心（世界中心映射，修正偏左）
  return { x1: cx - w*0.4, y1: y - h*0.88, x2: cx + w*0.4, y2: y };
}
