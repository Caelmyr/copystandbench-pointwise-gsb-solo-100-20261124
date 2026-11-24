'use strict';

const $ = id => document.getElementById(id);
const state = {project: null, shot: null, region: null, tool: null, drag: null, points: [], clipping: false,
  refresh: 0, reading: 0, saving: false, startBoxes: new Set(), startReport: null, startBusy: false};
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
  if (record) {
    const live = new Set(record.boxes.map(box => box.id));
    state.startBoxes = new Set([...state.startBoxes].filter(id => live.has(id)));
    if (state.startReport && state.startReport._project !== record.id) state.startReport = null;
  }
  render();
}

async function openProject(id, preferredStep = null) {
  const order = ++state.refresh;
  const record = id ? await request('/copydesk/projects/' + id) : null;
  if (order !== state.refresh) return;
  const shot = preferredStep === null ? null : record?.captures.find(item => item.step === preferredStep)?.id;
  state.clipping = false;
  state.startBoxes = new Set();
  state.startReport = null;
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
      const record = response.record || response;
      const capturedStep = Number($('shotStep').value);
      const shot = path === '/captures' ? record.captures.find(item => item.step === capturedStep)?.id : state.shot;
      const newBox = path === '/boxes' ? record.boxes.at(-1)?.id : state.region;
      accept(record, shot, newBox);
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
  $('viewerHint').textContent = adopted ? '已采用起始档 ' + stepLabel(adopted.step) + ' · ' + adopted.name :
    '在下方“起始档校准”勾选检查框并计算可重复拨回的起始档。';
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
  renderStartPanel();
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
}

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

function renderStartPanel() {
  const project = state.project;
  const panel = $('startBoxes');
  if (!project) return;
  panel.innerHTML = project.boxes.map(box =>
    '<label class="start-check"><input type="checkbox" data-start-box="' + box.id + '"' +
    (state.startBoxes.has(box.id) ? ' checked' : '') + '><span>' + escapeHtml(box.name) +
    ' <small>' + box.bounds.join(', ') + '</small></span></label>').join('');
  const checked = state.startBoxes.size;
  $('evaluateStart').disabled = state.startBusy || checked < 2;
  const report = state.startReport;
  const adopted = project.focus_start;
  const snapshot = new Map((adopted?.evaluation?.box_results || []).map(item => [item.box, item.bounds]));
  const sameBoxes = adopted && adopted.box_ids.length === state.startBoxes.size &&
    adopted.box_ids.every(id => state.startBoxes.has(id)) &&
    [...state.startBoxes].every(id => adopted.box_ids.includes(id));
  const unchanged = Boolean(sameBoxes) && adopted.box_ids.every(id => {
    const live = boxAt(id);
    const saved = snapshot.get(id);
    return live && saved && live.bounds.length === saved.length &&
      live.bounds.every((value, index) => value === saved[index]);
  });
  const stale = !unchanged;
  $('adoptStart').disabled = state.startBusy || !report?.ok;
  $('sealStart').disabled = !adopted || stale;
  if (!adopted) {
    $('startHint').textContent = checked < 2 ? '至少勾选两个已有检查框。' :
      '计算后按每个勾选框自身的最高有效清晰度判断过线。';
  } else if (stale) {
    $('startHint').textContent = '当前勾选与已采用起始档（' + adopted.box_ids.length +
      ' 个检查框）不一致，封存前请重新计算并采用。';
  } else {
    $('startHint').textContent = '已采用起始档 ' + stepLabel(adopted.step) + '，可封存复核单。';
  }
  renderStartResult();
}

function renderStartResult() {
  const wrap = $('startResult');
  const report = state.startReport;
  if (!report) {
    wrap.hidden = true;
    wrap.replaceChildren();
    return;
  }
  wrap.hidden = false;
  const warningItems = (report.warnings || []).map(item => '<li>' + escapeHtml(item.message) + '</li>').join('');
  const warningBlock = warningItems ? '<div class="start-warn"><b>无效读数（未参与过线判断）</b><ul>' +
    warningItems + '</ul></div>' : '';
  if (!report.ok) {
    const items = report.failures.map(item => '<li>' + escapeHtml(item.message) + '</li>').join('');
    wrap.innerHTML = '<div class="start-fail"><b>没有能用的起始档，不能据此采用。</b><ul>' + items + '</ul></div>' +
      warningBlock + renderStartTable(report);
    return;
  }
  const chosen = report.recommendation;
  const others = report.candidates.filter(item => item.step !== chosen.step);
  const weakName = report.box_results.find(item => item.box === chosen.weakest_box)?.name || '';
  const head = '<div class="start-ok"><div><b>推荐起始档 ' + stepLabel(chosen.step) + '</b>' +
    '<span>起始档与前后各一档（' + [chosen.step - 1, chosen.step, chosen.step + 1].map(stepLabel).join('、') +
    '）均有实拍且每个勾选框全部过线</span></div>' +
    '<div class="start-metrics"><span>连续合格档 <b>' + chosen.run_length + '</b> 档（' +
    chosen.run_steps.map(stepLabel).join('、') + '）</span><span>最弱框离过线余量 <b>+' +
    fixed(chosen.weakest_margin_pct, 1) + '%</b> · ' + escapeHtml(weakName) + '</span></div></div>';
  const alt = others.length ? '<p class="start-alts">其余可用起始档：' + others.map(item =>
    '档位 ' + stepLabel(item.step) + '（连续 ' + item.run_length + ' 档，最弱余量 +' +
    fixed(item.weakest_margin_pct, 1) + '%）').join('；') +
    '。已优先选择连续合格档更长、最弱框余量更大的一档。</p>' : '';
  wrap.innerHTML = head + alt + warningBlock + renderStartTable(report);
}

function renderStartTable(report) {
  const steps = report.steps;
  const head = '<tr><th>检查框</th><th>参照档（最高有效清晰度）</th><th>过线 85%</th>' +
    steps.map(step => '<th>' + stepLabel(step) + '</th>').join('') + '</tr>';
  const rows = report.box_results.map(item => {
    const cells = item.samples.map(sample => {
      const valid = sample.tone_valid;
      const state = valid ? (sample.passes ? 'pass' : 'fail') : 'invalid';
      const title = valid ? '清晰度 ' + sample.score + ' · 灰阶跨度 ' + sample.tone_span :
        '灰阶跨度 ' + sample.tone_span + ' 低于 8，读数无效';
      return '<td class="cell-' + state + '" title="' + title + '">' +
        (valid ? (sample.passes ? '过' : '未过') : '无效') +
        '<small>' + fixed(sample.score, 0) + '</small></td>';
    }).join('');
    return '<tr><td>' + escapeHtml(item.name) + '</td><td>' +
      (item.reference ? '档位 ' + stepLabel(item.reference.step) + ' · ' + fixed(item.reference.score) : '无有效读数') +
      '</td><td>' + (item.threshold === null ? '—' : fixed(item.threshold)) + '</td>' + cells + '</tr>';
  }).join('');
  return '<div class="start-table-wrap"><table class="start-table"><thead>' + head + '</thead><tbody>' +
    rows + '</tbody></table></div>';
}

async function refreshProofs() {
  $('proofs').textContent = '暂无复核单。';
  if (!state.project) return;
  const project = state.project.id;
  const proofs = await request(projectPath() + '/proofs');
  if (state.project?.id !== project || proofs.length === 0) return;
  $('proofs').innerHTML = proofs.map(item =>
    '<button type="button" data-proof="' + item.id + '">打开起始档 ' + stepLabel(item.capture.step) +
    ' · ' + (item.kind === 'focus_start' ? item.boxes.length + ' 个检查框' : escapeHtml(item.region.name)) +
    '</button>').join('');
}

function openDialog(title, content) {
  $('dialogTitle').textContent = title;
  $('dialogBody').innerHTML = content;
  if (!$('dialog').open) $('dialog').showModal();
}

function detailFigure(title, source) {
  return '<figure><img alt="" src="' + source + '"><figcaption>' + escapeHtml(title) + '</figcaption></figure>';
}

function proofReadingMarkup(item, ratio) {
  const reading = item.reading;
  const physical = reading.physical;
  const lighting = reading.lighting;
  const dims = physical ? fixed(physical.width_mm, 1) + ' × ' + fixed(physical.height_mm, 1) + ' mm' : '未标定';
  const grid = lighting.median_grid.flat().map(value => '<span>' + fixed(value, 1) + '</span>').join('');
  const sample = item.adopted_sample;
  const ref = item.reference;
  return '<div class="stat-row">' + stat('采用档清晰度', fixed(sample.score)) +
    stat('灰阶跨度', fixed(sample.tone_span, 1)) +
    stat('过线阈值（参照 × ' + (ratio * 100).toFixed(0) + '%）', fixed(item.threshold)) +
    stat('参照档 / 最高有效清晰度', stepLabel(ref.step) + ' · ' + fixed(ref.score)) +
    stat('复制现场尺寸', dims) +
    stat('近纯白', fixed(lighting.clippedWhitePct, 1) + ' %') + '</div>' +
    '<div class="grid-readout"><div>' + grid + '</div><span>局部亮度中位数 · 九格读数</span></div>';
}

async function openProof(id) {
  const base = projectPath() + '/proofs/' + id;
  const proof = await request(base);
  const selected = '起始档 ' + stepLabel(proof.capture.step) + ' · ' + proof.capture.name;
  if (proof.kind !== 'focus_start' || !proof.boxes) {
    const bounds = proof.region.bounds;
    const figures = detailFigure(selected, base + '/source.png') +
      detailFigure(proof.region.name + ' · 原照坐标 ' + bounds.join(', '), base + '/detail.png');
    openDialog('已封存 · ' + proof.title, '<div class="photo-pair">' + figures + '</div>' +
      '<div class="archived-detail">' + readingMarkup(proof.reading) + '</div>' +
      proofDownloads(base));
    return;
  }
  const tabs = proof.boxes.map((item, index) =>
    '<button type="button" class="proof-tab' + (index === 0 ? ' current' : '') +
    '" data-proof-box="' + index + '">' + escapeHtml(item.name) + '</button>').join('');
  const panels = proof.boxes.map((item, index) => {
    const figures = detailFigure(selected, base + '/source.png') +
      detailFigure(item.name + ' · 原照坐标 ' + item.bounds.join(', '), base + '/' + item.detail);
    return '<div class="proof-pane" data-proof-pane="' + index + '"' + (index ? ' hidden' : '') + '>' +
      '<div class="photo-pair">' + figures + '</div>' +
      '<div class="archived-detail">' + proofReadingMarkup(item, proof.pass_ratio) + '</div></div>';
  }).join('');
  const reason = '<p class="proof-reason">推荐理由：起始档与前后各一档均有实拍且全部勾选框过线；连续合格档 ' +
    proof.recommendation.run_length + ' 档（' + proof.recommendation.run_steps.map(stepLabel).join('、') +
    '），最弱框离过线余量 +' + fixed(proof.recommendation.weakest_margin_pct, 1) + '%。</p>';
  openDialog('已封存 · ' + proof.title,
    '<div class="proof-tabs" role="tablist">' + tabs + '</div>' + panels + reason + proofDownloads(base));
}

function proofDownloads(base) {
  return '<div class="row wrap"><a class="button" href="' + base + '/review.zip" download>下载复核 ZIP</a>' +
    '<a class="button" href="' + base + '/source.png?download=1" download>原照 PNG</a></div>';
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
$('startBoxes').onchange = event => {
  const hit = event.target.closest('[data-start-box]');
  if (!hit) return;
  if (hit.checked) state.startBoxes.add(hit.dataset.startBox);
  else state.startBoxes.delete(hit.dataset.startBox);
  state.startReport = null;
  renderStartPanel();
};
$('evaluateStart').onclick = safe(async () => {
  if (state.startBoxes.size < 2) throw Error('请至少勾选两个已有检查框。');
  state.startBusy = true;
  renderStartPanel();
  try {
    const report = await request(projectPath() + '/start-step', 'POST',
      {boxes: [...state.startBoxes]});
    report._project = state.project.id;
    state.startReport = report;
    if (report.ok) {
      const chosen = report.recommendation;
      notice('起始档计算完成：推荐档位 ' + stepLabel(chosen.step) + '，连续合格 ' +
        chosen.run_length + ' 档，最弱框余量 +' + fixed(chosen.weakest_margin_pct, 1) + '%。');
    } else {
      notice('没有能用的起始档，请查看失败的缺拍档或检查框。', true);
    }
    renderStartPanel();
  } finally {
    state.startBusy = false;
    renderStartPanel();
  }
});
$('adoptStart').onclick = safe(async () => {
  if (!state.startReport?.ok) throw Error('请先计算出能用的起始档。');
  const response = await mutate('/adopt', 'PATCH', {boxes: [...state.startBoxes]},
    '已采用推荐起始档，后续批扫可拨回该档。');
  state.startReport = response.evaluation;
  state.startReport._project = state.project.id;
  renderStartPanel();
  const shot = shotAt(state.project.selected);
  if (shot) changeShot(shot.id);
});
$('sealStart').onclick = safe(async () => {
  const proof = await request(projectPath() + '/proofs', 'POST', {revision: state.project.revision});
  await refreshProofs();
  await openProof(proof.id);
  notice('复核单已封存。');
});
$('dialog').onclick = event => {
  const tab = event.target.closest('[data-proof-box]');
  if (!tab) return;
  const dialog = $('dialog');
  dialog.querySelectorAll('.proof-tab').forEach(item =>
    item.classList.toggle('current', item === tab));
  dialog.querySelectorAll('.proof-pane').forEach(item =>
    item.hidden = item.dataset.proofPane !== tab.dataset.proofBox);
};
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
$('proofs').onclick = safe(event => { const hit = event.target.closest('[data-proof]'); if (hit) return openProof(hit.dataset.proof); });
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
