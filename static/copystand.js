'use strict';

const $ = id => document.getElementById(id);
const state = {project: null, shot: null, region: null, tool: null, drag: null, points: [], clipping: false,
  refresh: 0, reading: 0, saving: false, lighting: null};
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => (
  {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const stepLabel = step => step > 0 ? '+' + step : String(step);
const fixed = (value, digits = 2) => value === null || value === undefined ? '—' : value.toFixed(digits);
const projectPath = () => '/copydesk/projects/' + state.project.id;
const shotPath = id => projectPath() + '/captures/' + id;
const regionPath = (shot, region) => shotPath(shot) + '/boxes/' + region;
const shotAt = id => state.project?.captures.find(shot => shot.id === id);
const boxAt = id => state.project?.boxes.find(box => box.id === id);

async function request(path, method = 'GET', data) {
  const options = {method};
  if (data instanceof FormData) {
    options.body = data;
  } else if (data !== undefined) {
    options.headers = {'Content-Type': 'application/json'};
    options.body = JSON.stringify(data);
  }
  const response = await fetch(path, options);
  const value = await response.json();
  if (!response.ok) throw Error(value.error || '操作未完成。');
  return value;
}

function notice(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

function safe(action) {
  return async event => {
    try { await action(event); }
    catch (error) { notice(error.message, true); }
  };
}

async function projects() {
  const list = await request('/copydesk/projects');
  $('projects').replaceChildren(new Option('选择已有台位', ''));
  for (const item of list) $('projects').add(new Option(item.title, item.id));
  $('projects').value = state.project?.id || '';
}

function rememberProject() {
  const url = new URL(location.href);
  url.search = '';
  if (state.project) url.searchParams.set('project', state.project.id);
  history.replaceState(null, '', url);
}

function accept(record, shotId = state.shot, regionId = state.region) {
  state.project = record;
  state.shot = shotAt(shotId)?.id || record?.selected ||
    (record?.captures.find(shot => shot.step === 0) || record?.captures[0])?.id || null;
  state.region = boxAt(regionId)?.id || record?.boxes[0]?.id || null;
  state.tool = null;
  state.drag = null;
  state.points = [];
  render();
}

async function openProject(id, preferredStep = null) {
  const order = ++state.refresh;
  const record = id ? await request('/copydesk/projects/' + id) : null;
  if (order !== state.refresh) return;
  const shot = preferredStep === null ? null : record?.captures.find(item => item.step === preferredStep)?.id;
  state.clipping = false;
  accept(record, shot, null);
  rememberProject();
  $('projects').value = record?.id || '';
  $('boxName').value = '';
  await refreshProofs();
}

async function mutate(path, method, data, message) {
  if (state.saving || !state.project) throw Error('请等当前操作完成。');
  state.saving = true;
  const project = state.project.id;
  try {
    if (data instanceof FormData) data.set('revision', state.project.revision);
    else data = {revision: state.project.revision, ...data};
    const response = await request(projectPath() + path, method, data);
    if (state.project?.id === project) {
      const capturedStep = Number($('shotStep').value);
      const shot = path === '/captures' ? response.captures.find(item => item.step === capturedStep)?.id : state.shot;
      const newBox = path === '/boxes' ? response.boxes.at(-1)?.id : state.region;
      accept(response, shot, newBox);
      notice(message);
    }
    return response;
  } finally {
    state.saving = false;
  }
}

function changeShot(id) {
  if (!shotAt(id)) return;
  state.shot = id;
  state.tool = null;
  state.drag = null;
  state.points = [];
  render();
}

function changeRegion(id) {
  if (!boxAt(id)) return;
  state.region = id;
  state.tool = null;
  state.drag = null;
  state.points = [];
  $('boxName').value = '';
  render();
}

function render() {
  const project = state.project;
  const shot = shotAt(state.shot);
  const box = boxAt(state.region);
  $('emptyProject').hidden = Boolean(project);
  $('desk').hidden = !project;
  $('projectTag').hidden = !project?.synthetic;
  $('projectCounts').textContent = project ? project.captures.length + ' 档 · ' + project.boxes.length + ' 个检查框' : '';
  if (!project) return;
  const adopted = shotAt(project.selected);
  const currentAdopted = shot?.id === adopted?.id;
  $('noCapture').hidden = Boolean(shot);
  $('frameView').hidden = !shot;
  $('captureInfo').textContent = shot ? '档位 ' + stepLabel(shot.step) + ' · ' + shot.name + ' · ' + project.size.join(' × ') :
    '尚未导入照片';
  $('selectedBounds').textContent = box ? box.bounds.join(', ') : '';
  $('scaleText').textContent = project.scale ? fixed(project.scale.pixels_per_mm, 3) + ' px/mm' : '未标定';
  $('viewerHint').textContent = adopted ? '已采用档位 ' + stepLabel(adopted.step) + ' · ' + adopted.name :
    '检查清楚后采用一档原照。';
  $('adopt').disabled = !shot || currentAdopted;
  $('adopt').textContent = shot && currentAdopted ? '当前原照已采用' : '采用当前原照';
  $('clipToggle').disabled = !shot;
  $('clipToggle').setAttribute('aria-pressed', String(state.clipping));
  $('clipToggle').textContent = state.clipping ? '回到原照' : '欠曝／过曝';
  $('rawDownload').hidden = !shot;
  $('contactDownload').href = projectPath() + '/contact.png?download=1';
  $('contactDownload').hidden = !shot;
  $('newBox').disabled = !shot || project.boxes.length >= 8;
  $('replaceBox').disabled = !box;
  $('removeBox').disabled = !box;
  $('setScale').disabled = !shot;
  $('resetScale').disabled = !project.scale;
  $('detailDownload').hidden = !shot || !box;
  $('compare').disabled = !shot || !adopted || !box || currentAdopted;
  $('seal').disabled = !adopted || !box;
  if (shot) {
    const source = shotPath(shot.id) + (state.clipping ? '/clipping.png' : '/source.png');
    if ($('frameImage').getAttribute('src') !== source) $('frameImage').src = source;
    $('rawDownload').href = shotPath(shot.id) + '/source.png?download=1';
    if (box) $('detailDownload').href = regionPath(shot.id, box.id) + '/detail.png?download=1';
  }
  $('boxes').innerHTML = project.boxes.map(item =>
    '<button type="button" class="region' + (item.id === box?.id ? ' current' : '') + '" data-box="' + item.id +
    '" aria-pressed="' + (item.id === box?.id) + '">' + escapeHtml(item.name) + '</button>').join('');
  $('captures').innerHTML = project.captures.map(item => {
    const current = item.id === shot?.id;
    const accepted = item.id === adopted?.id;
    return '<button type="button" class="shot' + (current ? ' current' : '') + (accepted ? ' adopted' : '') +
      '" data-shot="' + item.id + '" title="' + escapeHtml(item.name) + '" aria-pressed="' + current +
      '"><img src="' + shotPath(item.id) + '/thumb.jpg" alt=""><span>档位 ' + stepLabel(item.step) +
      (accepted ? ' · 已采用' : '') + '</span></button>';
  }).join('');
  updatePrepareLink();
  paint();
  void refreshReadings();
  renderLightingDesk();
}

function renderLightingDesk() {
  const project = state.project;
  const box = boxAt(state.region);
  const shots = project ? project.captures : [];
  const keep = value => shots.some(item => item.id === value) ? value : '';
  for (const [selectId, fallback] of [['lightShotA', shots[0]?.id], ['lightShotB', shots[1]?.id]]) {
    const select = $(selectId);
    const touched = Object.prototype.hasOwnProperty.call(select.dataset, 'touched');
    const chosen = keep(select.dataset.value) || (!touched && !state.lighting ? fallback || '' : '');
    select.replaceChildren(new Option('选择原照', ''));
    for (const item of shots) {
      select.add(new Option('档位 ' + stepLabel(item.step) + ' · ' + item.name, item.id));
    }
    select.value = chosen || '';
    select.dataset.value = select.value;
  }
  $('lightBoxHint').textContent = box
    ? '检查框「' + box.name + '」按 2 列 × 3 行切成左右六格，同一水平带的左右两格配成三对。'
    : '使用当前所选检查框，按 2 列 × 3 行切成左右六格，同一水平带左右配成三对。';
  const ready = shots.length >= 2 && Boolean(box) &&
    $('lightShotA').value && $('lightShotB').value && $('lightShotA').value !== $('lightShotB').value;
  $('lightCheck').disabled = !ready;
  $('lightSeal').disabled = !ready || !state.lighting;
}

$('lightShotA').onchange = $('lightShotB').onchange = event => {
  event.target.dataset.touched = '1';
  event.target.dataset.value = event.target.value;
  state.lighting = null;
  $('lightingResult').textContent = '选择两张换位原照后开始检查。';
  renderLightingDesk();
};

function updatePrepareLink() {
  if (!state.project) return;
  $('prepareLink').href = '/prepare?copydesk=' + state.project.id + '&step=' +
    encodeURIComponent($('shotStep').value);
}

function drawBox(ctx, bounds, label, color, width) {
  const [x0, y0, x1, y1] = bounds;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  if (!label) return;
  const height = width * 8;
  ctx.font = 'bold ' + width * 5 + 'px sans-serif';
  ctx.fillStyle = color;
  const textWidth = ctx.measureText(label).width + width * 4;
  ctx.fillRect(x0, Math.max(0, y0 - height), textWidth, height);
  ctx.fillStyle = '#172017';
  ctx.fillText(label, x0 + width * 2, Math.max(0, y0 - height) + width * 6);
}

function paint() {
  const project = state.project;
  const canvas = $('frameCanvas');
  $('frameView').classList.toggle('drawing', Boolean(state.tool));
  if (!project?.size) return;
  const [width, height] = project.size;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const screenScale = canvas.clientWidth ? width / canvas.clientWidth : 1;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  for (const region of project.boxes) {
    if (region.id !== state.region) drawBox(ctx, region.bounds, '', '#f3f7c5a8', screenScale);
  }
  const active = boxAt(state.region);
  if (active) drawBox(ctx, active.bounds, active.name, '#d8f476', 2 * screenScale);
  if (state.drag) drawBox(ctx, ordered(state.drag.start, state.drag.end), '', '#a4f8fb', 2 * screenScale);
  const points = state.tool === 'scale' ? state.points : project.scale ? [project.scale.from, project.scale.to] : [];
  if (points.length) {
    ctx.strokeStyle = '#a4f8fb';
    ctx.fillStyle = '#a4f8fb';
    ctx.lineWidth = 2 * screenScale;
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    if (points.length === 2) { ctx.lineTo(...points[1]); ctx.stroke(); }
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(point[0], point[1], 3.4 * screenScale, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function stat(label, value) {
  return '<div class="stat"><span class="stat-caption">' + label + '</span><strong>' + value + '</strong></div>';
}

function readingMarkup(reading) {
  const physical = reading.physical;
  const lighting = reading.lighting;
  const dims = physical ? fixed(physical.width_mm, 1) + ' × ' + fixed(physical.height_mm, 1) + ' mm' : '未标定';
  const grid = lighting.median_grid.flat().map(value => '<span>' + fixed(value, 1) + '</span>').join('');
  return '<div class="stat-row">' + stat('清晰度', fixed(reading.focus.score)) +
    stat('灰阶跨度', fixed(reading.focus.tone_span, 1)) + stat('复制现场尺寸', dims) +
    stat('最暗格相对中心', fixed(lighting.center_falloff_pct, 1) + ' %') +
    stat('中性偏色 R/G/B', lighting.rgb_means.map(value => fixed(value, 0)).join(' / ')) +
    stat('近纯白', fixed(lighting.clippedWhitePct, 1) + ' %') + '</div>' +
    '<div class="grid-readout"><div>' + grid + '</div><span>局部亮度中位数 · 九格读数</span></div>';
}

async function refreshReadings() {
  const read = ++state.reading;
  const shot = shotAt(state.shot);
  const box = boxAt(state.region);
  $('readingName').textContent = box?.name || '';
  $('reading').textContent = '选一张原照与一个检查框。';
  $('curves').textContent = '选择检查框后可点档位回看原照。';
  $('exposureStats').textContent = '';
  $('histogram').innerHTML = '';
  if (!shot) return;
  const exposure = request(shotPath(shot.id) + '/exposure').then(data => {
    if (state.reading !== read) return;
    $('exposureStats').textContent = '近黑 ' + fixed(data.dark, 1) + '% · 近白 ' + fixed(data.bright, 1) + '%';
    const max = Math.max(1, ...data.histogram);
    $('histogram').innerHTML = data.histogram.map(count => '<span style="height:' + count / max * 100 + '%"></span>').join('');
  });
  const detail = box ? Promise.all([
    request(regionPath(shot.id, box.id)), request(projectPath() + '/boxes/' + box.id + '/curve')
  ]).then(([reading, curve]) => {
    if (state.reading !== read) return;
    $('reading').innerHTML = readingMarkup(reading);
    const max = Math.max(1, ...curve.samples.map(item => item.score));
    $('curves').innerHTML = curve.samples.map(item =>
      '<button type="button" data-curve-shot="' + item.capture + '" class="curve-step' +
      (item.capture === shot.id ? ' current' : '') + '" title="档位 ' + stepLabel(item.step) + ' · ' +
      fixed(item.score) + '"><span class="bar" style="height:' + Math.max(2, 66 * item.score / max) +
      'px"></span><b>' + stepLabel(item.step) + '</b><small>' + fixed(item.score, 0) + '</small></button>').join('');
  }) : Promise.resolve();
  try { await Promise.all([exposure, detail]); }
  catch (error) { if (state.reading === read) notice(error.message, true); }
}

async function refreshProofs() {
  $('proofs').textContent = '暂无复核单。';
  if (!state.project) return;
  const project = state.project.id;
  const proofs = await request(projectPath() + '/proofs');
  if (state.project?.id !== project || proofs.length === 0) return;
  $('proofs').innerHTML = proofs.map(item => {
    if (item.kind === 'lighting') {
      return '<button type="button" data-proof="' + item.id + '" data-kind="lighting">布光检查 · ' +
        escapeHtml(item.lighting.region.name) + '</button>';
    }
    return '<button type="button" data-proof="' + item.id + '">打开档位 ' + stepLabel(item.capture.step) +
      ' · ' + escapeHtml(item.region.name) + '</button>';
  }).join('');
}

function openDialog(title, content) {
  $('dialogTitle').textContent = title;
  $('dialogBody').innerHTML = content;
  if (!$('dialog').open) $('dialog').showModal();
}

function detailFigure(title, source) {
  return '<figure><img alt="" src="' + source + '"><figcaption>' + escapeHtml(title) + '</figcaption></figure>';
}

async function openProof(id) {
  const base = projectPath() + '/proofs/' + id;
  const proof = await request(base);
  const selected = '档位 ' + stepLabel(proof.capture.step) + ' · ' + proof.capture.name;
  const bounds = proof.region.bounds;
  const detail = proof.region.name + ' · 原照坐标 ' + bounds.join(', ');
  const figures = detailFigure(selected, base + '/source.png') + detailFigure(detail, base + '/detail.png');
  openDialog('已封存 · ' + proof.title, '<div class="photo-pair">' + figures + '</div>' +
    '<div class="archived-detail">' + readingMarkup(proof.reading) + '</div>' +
    '<div class="row wrap"><a class="button" href="' + base + '/review.zip" download>下载复核 ZIP</a>' +
    '<a class="button" href="' + base + '/source.png?download=1" download>原照 PNG</a>' +
    '<a class="button" href="' + base + '/detail.png?download=1" download>裁片 PNG</a></div>');
}

function ordered(first, second) {
  return [Math.min(first[0], second[0]), Math.min(first[1], second[1]),
    Math.max(first[0], second[0]), Math.max(first[1], second[1])];
}

function point(event, ruler = false) {
  const rect = $('frameCanvas').getBoundingClientRect();
  const [width, height] = state.project.size;
  const across = Math.round((event.clientX - rect.left) / rect.width * width);
  const down = Math.round((event.clientY - rect.top) / rect.height * height);
  return [Math.min(width - Number(ruler), Math.max(0, across)),
    Math.min(height - Number(ruler), Math.max(0, down))];
}

function startTool(tool, message) {
  state.tool = tool;
  state.drag = null;
  state.points = [];
  notice(message);
  paint();
}

$('frameImage').onload = paint;
window.addEventListener('resize', paint);
$('frameCanvas').onpointerdown = safe(async event => {
  if (!state.tool || event.button !== 0) return;
  if (state.tool === 'scale') {
    state.points.push(point(event, true));
    paint();
    if (state.points.length === 2) {
      const [first, second] = state.points;
      state.points = [];
      await mutate('/scale', 'PATCH', {ruler: {from: first, to: second, millimeters: Number($('scaleLength').value)}},
        '复制比例已保存。');
    }
    return;
  }
  const start = point(event);
  state.drag = {start, end: start};
  $('frameCanvas').setPointerCapture(event.pointerId);
});
$('frameCanvas').onpointermove = event => {
  if (!state.drag) return;
  state.drag.end = point(event);
  paint();
};
$('frameCanvas').onpointercancel = () => { state.drag = null; paint(); };
$('frameCanvas').onpointerup = safe(async event => {
  if (!state.drag) return;
  const bounds = ordered(state.drag.start, point(event));
  state.drag = null;
  const edit = state.tool === 'edit';
  await mutate(edit ? '/boxes/' + state.region : '/boxes', edit ? 'PATCH' : 'POST',
    {name: $('boxName').value.trim() || (edit ? boxAt(state.region).name : '检查框 ' + (state.project.boxes.length + 1)),
      bounds}, '检查框已保存。');
  $('boxName').value = '';
});

$('newProject').onsubmit = safe(async event => {
  event.preventDefault();
  const project = await request('/copydesk/projects', 'POST', {title: $('projectTitle').value});
  $('projectTitle').value = '';
  await projects();
  await openProject(project.id);
  notice('台位已创建。');
});
$('startDemo').onclick = safe(async () => {
  const project = await request('/copydesk/demo', 'POST', {});
  await projects();
  await openProject(project.id);
  notice('已加载合成校准片。');
});
$('projects').onchange = safe(event => openProject(event.target.value));
$('shotStep').oninput = updatePrepareLink;
$('upload').onsubmit = safe(async event => {
  event.preventDefault();
  const data = new FormData();
  data.set('step', $('shotStep').value);
  data.set('image', $('shotFile').files[0]);
  await mutate('/captures', 'POST', data, '原照已导入。');
  $('shotFile').value = '';
});
$('newBox').onclick = () => startTool('draw', '在原照上拖出检查框，短边至少 24 像素。');
$('replaceBox').onclick = () => startTool('edit', '在原照上拖出所选框的新范围。');
$('setScale').onclick = () => startTool('scale', '依次点击原照上两个标尺端点。');
$('removeBox').onclick = safe(() => mutate('/boxes/' + state.region, 'DELETE', {}, '已移除检查框。'));
$('resetScale').onclick = safe(() => mutate('/scale', 'PATCH', {ruler: null}, '已清除比例标定。'));
$('clipToggle').onclick = () => { state.clipping = !state.clipping; render(); };
$('adopt').onclick = safe(() => mutate('/adopt', 'PATCH', {capture: state.shot}, '已采用该档原照。'));
$('seal').onclick = safe(async () => {
  const proof = await request(projectPath() + '/proofs', 'POST', {revision: state.project.revision, box: state.region});
  await refreshProofs();
  await openProof(proof.id);
  notice('复核单已封存。');
});
$('compare').onclick = () => {
  const current = shotAt(state.shot);
  const adopted = shotAt(state.project.selected);
  const detail = shot => detailFigure('档位 ' + stepLabel(shot.step) + ' · ' + shot.name,
    regionPath(shot.id, state.region) + '/detail.png');
  openDialog('同框对照 · ' + boxAt(state.region).name, '<div class="photo-pair">' +
    detail(adopted) + detail(current) + '</div>');
};
$('closeDialog').onclick = () => $('dialog').close();
$('captures').onclick = event => { const hit = event.target.closest('[data-shot]'); if (hit) changeShot(hit.dataset.shot); };
$('boxes').onclick = event => { const hit = event.target.closest('[data-box]'); if (hit) changeRegion(hit.dataset.box); };
$('curves').onclick = event => { const hit = event.target.closest('[data-curve-shot]'); if (hit) changeShot(hit.dataset.curveShot); };
$('proofs').onclick = safe(async event => {
  const hit = event.target.closest('[data-proof]');
  if (!hit) return;
  if (hit.dataset.kind === 'lighting') return openLightingProof(hit.dataset.proof);
  return openProof(hit.dataset.proof);
});

const sideLabel = side => side === 'left' ? '左侧' : side === 'right' ? '右侧' : '—';

function lightObservationCell(cell, shotLabel, side) {
  return '<figure class="light-crop">' +
    (cell.crop ? '<img src="' + cell.crop + '" alt="' + shotLabel + side + '格原像素裁片">' : '') +
    '<figcaption>' + shotLabel + side + '格 · 线性亮度 ' + fixed(cell.mean_linear, 4) +
    '<br>近黑 ' + fixed(cell.near_black_pct, 1) + '% · 近白 ' + fixed(cell.near_white_pct, 1) + '%</figcaption></figure>';
}

function lightingPairMarkup(pair) {
  const rows = pair.shots.map(shot => {
    const label = shot.shot === 'a' ? '照片A（换位前）' : '照片B（转180°）';
    return '<div class="light-obs">' +
      lightObservationCell(shot.left, label, '左') +
      '<span class="light-swap">同一块卡面<br>换位对照</span>' +
      lightObservationCell(shot.right, label, '右') + '</div>';
  }).join('');
  let status, detail;
  if (!pair.usable) {
    status = '<span class="light-badge excluded">不参与</span>';
    detail = escapeHtml(pair.excluded_reason || '证据不足。');
  } else {
    const dim = pair.is_dim
      ? '<strong class="light-dim">' + sideLabel(pair.dim_side) + '偏暗 ' + fixed(pair.dim_pct, 1) + '%</strong>'
      : '<span class="light-even">两侧均衡（差 ' + fixed(pair.dim_pct, 1) + '%，不足 5%）</span>';
    status = pair.is_dim ? '<span class="light-badge dim">偏暗</span>' : '<span class="light-badge even">均衡</span>';
    detail = '左/右布光比 ' + fixed(pair.lighting_ratio, 3) +
      '（两观测 ' + fixed(pair.ratio_a, 3) + '、' + fixed(pair.ratio_b, 3) +
      '，相差 ' + fixed(pair.ratio_drift_pct, 1) + '%） · 较亮一侧：' + sideLabel(pair.bright_side) + ' · ' + dim;
  }
  return '<div class="light-pair">' +
    '<button type="button" class="light-pair-head" data-pair="' + pair.id + '" aria-expanded="false">' +
    '<span class="light-pair-name">' + escapeHtml(pair.name) + '</span>' + status +
    '<span class="light-pair-detail">' + detail + '</span><span class="light-open">点开看两张图同片卡面裁片 ▾</span></button>' +
    '<div class="light-pair-body" hidden>' + rows + '</div></div>';
}

function renderLighting(result) {
  const summary = result.summary;
  const head = '<div class="light-summary ' + (summary.enough ? 'ok' : 'warn') + '">' +
    '<b>可用配对 ' + summary.usable_count + ' / ' + summary.total_pairs + '</b>' +
    (summary.missing.length ? '<span>不参与：' + escapeHtml(summary.missing.join('、')) + '</span>' : '') +
    '</div>';
  const note = summary.enough
    ? '<p class="light-recommend">' + escapeHtml(summary.recommendation.message) + '</p>'
    : '<p class="light-recommend warn">' + escapeHtml(summary.reshoot) + '</p>';
  $('lightingResult').innerHTML = head + result.pairs.map(lightingPairMarkup).join('') + note;
}

$('lightingResult').onclick = event => {
  const hit = event.target.closest('[data-pair]');
  if (!hit) return;
  const body = hit.parentElement.querySelector('.light-pair-body');
  const open = body.hidden;
  body.hidden = !open;
  hit.setAttribute('aria-expanded', String(open));
};

$('lightCheck').onclick = safe(async () => {
  if (!state.region) throw Error('请先选择一个检查框。');
  state.lighting = null;
  $('lightingResult').textContent = '正在读取两张原照的原像素…';
  const result = await request(projectPath() + '/lighting/check', 'POST', {
    first: $('lightShotA').value, second: $('lightShotB').value, box: state.region});
  state.lighting = result;
  renderLighting(result);
  $('lightSeal').disabled = false;
});

$('lightSeal').onclick = safe(async () => {
  if (!state.lighting) throw Error('请先完成一次布光检查。');
  const proof = await request(projectPath() + '/lighting/proofs', 'POST', {
    revision: state.project.revision,
    first: $('lightShotA').value, second: $('lightShotB').value, box: state.region});
  state.lighting = null;
  await openProject(state.project.id);
  await openLightingProof(proof.id);
  notice('布光检查已存入复核单。');
});

function lightProofObservation(base, pair, shot, fileShot) {
  const sideCell = side => pair.shots.find(item => item.shot === shot)[side];
  const label = shot === 'a' ? '照片A（换位前）' : '照片B（转180°）';
  const fig = (side, text) => '<figure class="light-crop"><img src="' + base + '/' +
    pair.id + '-' + fileShot + '-' + side + '.png" alt="' + text + '"><figcaption>' + text +
    ' · 线性亮度 ' + fixed(sideCell(side).mean_linear, 4) + '<br>近黑 ' +
    fixed(sideCell(side).near_black_pct, 1) + '% · 近白 ' +
    fixed(sideCell(side).near_white_pct, 1) + '%</figcaption></figure>';
  return '<div class="light-obs">' + fig('left', label + '左格') +
    '<span class="light-swap">同一块卡面<br>换位对照</span>' + fig('right', label + '右格') + '</div>';
}

async function openLightingProof(id) {
  const base = projectPath() + '/proofs/' + id;
  const proof = await request(base);
  const result = proof.lighting;
  const summary = result.summary;
  const body = ['<div class="light-summary ' + (summary.enough ? 'ok' : 'warn') + '"><b>可用配对 ' +
    summary.usable_count + ' / ' + summary.total_pairs + '</b>' +
    (summary.missing.length ? '<span>不参与：' + escapeHtml(summary.missing.join('、')) + '</span>' : '') + '</div>'];
  for (const pair of result.pairs) {
    let head;
    if (!pair.usable) {
      head = '<span class="light-badge excluded">不参与</span><span class="light-pair-detail">' +
        escapeHtml(pair.excluded_reason || '证据不足。') + '</span>';
    } else {
      const dim = pair.is_dim
        ? '<strong class="light-dim">' + sideLabel(pair.dim_side) + '偏暗 ' + fixed(pair.dim_pct, 1) + '%</strong>'
        : '<span class="light-even">两侧均衡（差 ' + fixed(pair.dim_pct, 1) + '%）</span>';
      head = (pair.is_dim ? '<span class="light-badge dim">偏暗</span>' : '<span class="light-badge even">均衡</span>') +
        '<span class="light-pair-detail">左/右布光比 ' + fixed(pair.lighting_ratio, 3) +
        '（两观测相差 ' + fixed(pair.ratio_drift_pct, 1) + '%） · 较亮：' + sideLabel(pair.bright_side) + ' · ' + dim + '</span>';
    }
    body.push('<div class="light-pair"><div class="light-pair-head static"><span class="light-pair-name">' +
      escapeHtml(pair.name) + '</span>' + head + '</div><div class="light-pair-body">' +
      lightProofObservation(base, pair, 'a', 'a') + lightProofObservation(base, pair, 'b', 'b') +
      '</div></div>');
  }
  body.push('<p class="light-recommend' + (summary.enough ? '' : ' warn') + '">' +
    escapeHtml(summary.enough ? summary.recommendation.message : summary.reshoot) + '</p>');
  body.push('<p class="light-hint">检查框「' + escapeHtml(result.region.name) + '」坐标 ' +
    result.region.bounds.join(', ') + ' · 原照 ' +
    result.captures.map(c => '档位' + stepLabel(c.step)).join(' / ') + '</p>');
  openDialog('布光复核单 · ' + proof.title, body.join(''));
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.tool) {
    startTool(null, '已取消当前标记。');
  }
});
void safe(async () => {
  await projects();
  const query = new URLSearchParams(location.search);
  if (query.has('project')) await openProject(query.get('project'), query.has('step') ? Number(query.get('step')) : null);
})();
