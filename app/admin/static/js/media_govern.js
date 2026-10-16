// 素材库治理页的上传与批量脚本(2.5.0 从页面模板里搬出来: 真文件才有语法检查, 模板字符串会吃掉反斜杠、反引号会截断脚本)
(function () {
  'use strict';
  var CFG = window.__mediaGovernCfg || {};
  var BATCH_MAX = CFG.batchMax;
  var UPLOAD = CFG.uploadUrl;
  var MOVE = CFG.moveUrl;                       // 批量移动的确认页(与"移动目录"同一端点, 参数换成 paths)
  var MOVE_MAX = Number(CFG.moveMax) || 10;     // 移动每个对象要 4 次 R2 子请求, 上限比删除小
  var pickers = document.querySelectorAll('input[data-purpose]');   // 4 个入口: 图片/视频 × 文件/文件夹
  var startBtn = document.getElementById('mediaUploadStart');
  var clearBtn = document.getElementById('mediaUploadClear');
  var bar = document.getElementById('mediaUploadBar');
  var overallEl = document.getElementById('mediaUploadOverall');
  var currentEl = document.getElementById('mediaUploadCurrent');
  var listEl = document.getElementById('mediaUploadList');
  var listBox = document.getElementById('mediaUploadListBox');
  var doneEl = document.getElementById('mediaUploadDone');
  var queue = [];
  var running = false;
  var totalBytes = 0;
  var doneBytes = 0;
  var STATE_TEXT = { wait: '等待', doing: '上传中', ok: '成功', fail: '失败', skip: '已跳过' };

  // 体积文案: 待上传清单里常见几十 KB 的文件, 一律按 MB 显示会全是 0.0 MB
  function mb(value) {
    var bytes = Number(value || 0);
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
  // 目标路径: 每个入口一个下拉, 默认就是该入口的素材根(image/ 或 video/)
  function dirSelect(purpose) {
    return document.getElementById(purpose === 'video' ? 'mediaUploadVideoDir' : 'mediaUploadImageDir');
  }
  // 选「其它（手动填写）」时才露出手动输入框(默认状态下页面只有一个下拉, 不会多一个空框)
  function syncManual(select) {
    if (!select) return;
    var manual = document.getElementById(select.getAttribute('data-manual'));
    if (manual) manual.classList.toggle('d-none', select.value !== '__manual');
  }
  // 取值: 下拉选的就是提交值; 「其它」时取手动输入框的值
  function dirOf(purpose) {
    var select = dirSelect(purpose);
    if (!select) return '';
    if (select.value === '__manual') {
      var manual = document.getElementById(select.getAttribute('data-manual'));
      return manual ? manual.value.trim() : '';
    }
    return select.value;
  }
  // 目标路径前端先拦一道(免得整批文件各失败一次), 只拦"一定不合法"的几条; 唯一判定仍在服务端 safeTargetDir
  function dirProblem() {
    var rows = [{ purpose: 'cover', title: '图片' }, { purpose: 'video', title: '视频' }];
    for (var index = 0; index < rows.length; index += 1) {
      var value = dirOf(rows[index].purpose).replace(/\\/g, '/');
      if (!value || value === '/') continue;
      if (value.indexOf('..') !== -1) return rows[index].title + '的目标路径不能包含两个点（路径穿越）';
      if (value.charAt(0) === '/') return rows[index].title + '的目标路径不能是绝对路径：去掉开头的斜杠（要写存储桶最外层就选「根目录」）';
      var body = value.replace(/\/+$/, '');
      var pieces = body.split('/');
      for (var at = 0; at < pieces.length; at += 1) {
        if (!pieces[at] || pieces[at] === '.') return rows[index].title + '的目标路径有不合法的一段（空目录名或单个点）';
      }
    }
    return '';
  }
  function mode() {
    var picked = document.querySelector('input[name=mediaNameMode]:checked');
    return picked ? picked.value : 'auto';
  }
  // 文件夹上传: webkitRelativePath 形如 "顶层目录/子目录/文件", 整棵树原样带上(含选中的那层); 清洗交给服务端 safeRelPath
  function relOf(file) {
    return file.webkitRelativePath || '';
  }
  function counts() {
    var result = { ok: 0, fail: 0, wait: 0, skip: 0 };
    queue.forEach(function (item) {
      if (result[item.state] === undefined) return;
      result[item.state] += 1;
    });
    return result;
  }
  function render() {
    var stat = counts();
    var percent = totalBytes ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : 0;
    bar.style.width = percent + '%';
    bar.textContent = percent + '%';
    overallEl.textContent = queue.length
      ? '共 ' + queue.length + ' 个文件 · ' + mb(doneBytes) + ' / ' + mb(totalBytes)
        + ' · 成功 ' + stat.ok + ' · 失败 ' + stat.fail
        + (stat.skip ? ' · 跳过 ' + stat.skip : '') + (stat.wait ? ' · 待传 ' + stat.wait : '')
      : '等待选择文件…';
    startBtn.disabled = running || stat.wait === 0;
    renderList();
  }
  // 缩略图用 objectURL 直接预览本地文件(选完就能看); 移除或清空时必须 revoke, 否则那份文件的内存一直占着
  function thumbFor(item) {
    if (!item.file || !/^image\//.test(item.file.type || '')) return '';
    if (!item.thumb) item.thumb = URL.createObjectURL(item.file);
    return item.thumb;
  }
  function dropThumb(item) {
    if (item.thumb) { URL.revokeObjectURL(item.thumb); item.thumb = ''; }
  }
  // 分组键: 选文件夹时用选中的那层文件夹名(整组一次移除), 单独选的文件归到空键那一组(不建组头)
  function groupOf(item) {
    var rel = item.rel || '';
    var at = rel.indexOf('/');
    return at < 0 ? '' : rel.slice(0, at);
  }
  // 只有"还没传上去"的能移除: 已成功的对象在桶里, 正在传的撤不掉
  function canRemove(item) {
    return item.state === 'wait' || item.state === 'fail' || item.state === 'skip';
  }
  function buttonIn(text, className, onClick) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }
  function itemRow(item) {
    var li = document.createElement('li');
    li.className = 'upload-row' + (item.state === 'ok' ? ' text-success'
      : (item.state === 'fail' ? ' text-danger' : ''));
    var url = thumbFor(item);
    if (url) {
      var thumb = document.createElement('img');
      thumb.className = 'upload-thumb';
      thumb.src = url;
      thumb.alt = '';
      li.appendChild(thumb);
    } else {
      var icon = document.createElement('i');
      icon.className = 'upload-thumb upload-thumb-icon bi ' + (item.purpose === 'video' ? 'bi-film' : 'bi-image');
      icon.setAttribute('aria-hidden', 'true');
      li.appendChild(icon);
    }
    var main = document.createElement('div');
    main.className = 'upload-main';
    var name = document.createElement('div');
    name.className = 'upload-name';
    name.textContent = item.rel || item.file.name;   // 选文件夹时是整条相对路径, 单独选的文件只有文件名
    name.title = name.textContent;
    var meta = document.createElement('div');
    meta.className = 'upload-meta';
    meta.textContent = mb(item.file.size || 0) + ' · ' + (item.purpose === 'video' ? '视频' : '图片')
      + ' · ' + (STATE_TEXT[item.state] || item.state) + (item.message ? '：' + item.message : '');
    main.appendChild(name);
    main.appendChild(meta);
    li.appendChild(main);
    var actions = document.createElement('div');
    actions.className = 'upload-actions';
    if (item.state === 'fail') {
      actions.appendChild(buttonIn('重试', 'btn btn-sm btn-outline-secondary', function () {
        item.state = 'wait';
        item.message = '';
        render();
        run();
      }));
      actions.appendChild(buttonIn('跳过', 'btn btn-sm btn-link text-muted', function () {
        item.state = 'skip';
        render();
      }));
    }
    if (canRemove(item)) {
      actions.appendChild(buttonIn('移除', 'btn btn-sm btn-link text-muted', function () {
        removeItem(item);
      }));
    }
    li.appendChild(actions);
    return li;
  }
  function groupRow(key, items) {
    var li = document.createElement('li');
    li.className = 'upload-group';
    var icon = document.createElement('i');
    icon.className = 'bi bi-folder2-open';
    icon.setAttribute('aria-hidden', 'true');
    var name = document.createElement('span');
    name.textContent = key + '/（' + items.length + ' 个文件）';
    li.appendChild(icon);
    li.appendChild(name);
    if (items.some(canRemove)) {
      li.appendChild(buttonIn('移除整个文件夹', 'btn btn-sm btn-link text-muted ms-auto', function () {
        removeGroup(key);
      }));
    }
    return li;
  }
  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (listBox) listBox.classList.toggle('d-none', queue.length === 0);
    var groups = [];
    queue.forEach(function (item) {
      var key = groupOf(item);
      var found = null;
      for (var index = 0; index < groups.length; index += 1) {
        if (groups[index].key === key) { found = groups[index]; break; }
      }
      if (!found) { groups.push({ key: key, items: [item] }); return; }
      found.items.push(item);
    });
    groups.forEach(function (group) {
      if (group.key) listEl.appendChild(groupRow(group.key, group.items));
      group.items.forEach(function (item) { listEl.appendChild(itemRow(item)); });
    });
  }
  // 待传的体积要从 totalBytes 里扣掉, 否则移除后进度百分比算不回去(已传部分的 doneBytes 不变)
  function removeItem(item) {
    if (!canRemove(item)) return;
    if (item.state === 'wait') totalBytes -= item.file.size || 0;
    dropThumb(item);
    queue.splice(queue.indexOf(item), 1);
    render();
  }
  function removeGroup(key) {
    queue.slice().forEach(function (item) {
      if (groupOf(item) !== key || !canRemove(item)) return;
      if (item.state === 'wait') totalBytes -= item.file.size || 0;
      dropThumb(item);
      queue.splice(queue.indexOf(item), 1);
    });
    render();
  }
  function addFiles(list, purpose) {
    if (!list || !list.length) return;
    for (var index = 0; index < list.length; index += 1) {
      var file = list[index];
      // purpose 跟着文件走: 两种类型可以混在一个队列里, 各传各的目录
      queue.push({ file: file, rel: relOf(file), purpose: purpose, state: 'wait', message: '', thumb: '' });
      totalBytes += file.size || 0;
    }
    doneEl.innerHTML = '';
    render();
  }
  // 一个文件一个请求(顺序上传): 进度来自 XHR 的 upload.onprogress, 浏览器拿不到服务端处理进度
  function send(item, onProgress) {
    return new Promise(function (resolve) {
      var data = new FormData();
      data.set('file', item.file);
      data.set('purpose', item.purpose);       // 类型由入口决定, 服务端仍按文件头校验
      data.set('name_mode', mode());
      if (item.rel) data.set('rel_path', item.rel);   // 两种命名模式都保留目录结构
      var target = dirOf(item.purpose);        // 不填就不发, 服务端用默认目录
      if (target) data.set('target_dir', target);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', UPLOAD);
      xhr.upload.addEventListener('progress', function (event) {
        if (event.lengthComputable) onProgress(event.loaded);
      });
      xhr.addEventListener('load', function () {
        var payload = null;
        try { payload = JSON.parse(xhr.responseText); } catch (error) { payload = null; }
        if (xhr.status === 200 && payload && payload.success) resolve({ ok: true, url: payload.url });
        else resolve({ ok: false, message: (payload && payload.message) || ('HTTP ' + xhr.status) });
      });
      xhr.addEventListener('error', function () { resolve({ ok: false, message: '网络中断或超时' }); });
      xhr.addEventListener('abort', function () { resolve({ ok: false, message: '已取消' }); });
      xhr.send(data);
    });
  }
  function run() {
    if (running) return;
    var pending = queue.filter(function (item) { return item.state === 'wait'; });
    if (!pending.length) return;
    var problem = dirProblem();   // 目标路径有问题就整批不开跑, 而不是让每个文件各失败一次
    if (problem) {
      doneEl.innerHTML = '<span class="text-danger">' + problem + '</span>';
      return;
    }
    running = true;
    doneEl.innerHTML = '';
    render();
    var index = 0;
    function next() {
      if (index >= pending.length) {
        running = false;
        currentEl.textContent = '';
        var stat = counts();
        doneEl.innerHTML = '上传结束：成功 ' + stat.ok + ' 个、失败 ' + stat.fail + ' 个'
          + (stat.skip ? '、跳过 ' + stat.skip + ' 个' : '') + '。失败的可点「重试」。'
          + '<a class="btn btn-sm btn-outline-secondary ms-2" href="' + window.location.pathname + '">刷新列表</a>';
        render();
        return;
      }
      var item = pending[index];
      index += 1;
      item.state = 'doing';
      var size = item.file.size || 0;
      var sent = 0;
      var label = item.rel || item.file.name;
      currentEl.textContent = '正在上传：' + label + '（' + index + '/' + pending.length + '）';
      send(item, function (loaded) {
        doneBytes += Math.max(0, loaded - sent);
        sent = loaded;
        var percent = size ? Math.min(100, Math.round((loaded / size) * 100)) : 0;
        currentEl.textContent = '正在上传：' + label + ' ' + percent + '%（' + mb(loaded) + ' / ' + mb(size) + '）';
        render();
      }).then(function (result) {
        doneBytes += Math.max(0, size - sent);       // 兜住没触发 progress 的尾巴
        if (result.ok) {
          item.state = 'ok';
          item.url = result.url;                     // 重名时服务端改过 key, 以返回值为准
        } else {
          item.state = 'fail';
          item.message = result.message;
        }
        render();
        next();
      });
    }
    next();
  }
  Array.prototype.forEach.call(pickers, function (input) {
    input.addEventListener('change', function () {
      addFiles(input.files, input.getAttribute('data-purpose'));
      input.value = '';   // 清空才能重复选同一批文件, 也避免"加过的文件又加一遍"
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('select[data-manual]'), function (select) {
    select.addEventListener('change', function () { syncManual(select); });
  });
  if (startBtn) startBtn.addEventListener('click', run);
  if (clearBtn) clearBtn.addEventListener('click', function () {
    if (running) return;
    queue.forEach(dropThumb);   // 缩略图的 objectURL 一起回收
    queue = [];
    totalBytes = 0;
    doneBytes = 0;
    currentEl.textContent = '';
    doneEl.innerHTML = '';
    render();
  });
  render();

  var batchForm = document.getElementById('mediaBatchForm');
  if (!batchForm) return;
  var hidden = document.getElementById('mediaBatchPaths');
  var countEl = document.getElementById('mediaBatchCount');
  var button = document.getElementById('mediaBatchDelete');
  var moveBtn = document.getElementById('mediaBatchMove');
  function picked() {
    return Array.prototype.filter.call(document.querySelectorAll('[data-media-pick]'), function (box) { return box.checked; })
      .map(function (box) { return box.getAttribute('value'); });
  }
  function refresh() {
    var list = picked();
    // 服务端按 JSON 数组解析 paths: 键名里允许逗号, 用逗号拼会拆错(见 keysOf)
    if (hidden) hidden.value = JSON.stringify(list);
    if (countEl) countEl.textContent = '已选 ' + list.length + ' 个' + (list.length > BATCH_MAX ? '（一次最多 ' + BATCH_MAX + ' 个）' : '');
    if (button) button.disabled = list.length === 0 || list.length > BATCH_MAX;
    if (moveBtn) moveBtn.disabled = list.length === 0 || list.length > MOVE_MAX;
  }
  document.addEventListener('change', function (event) {
    if (event.target && event.target.hasAttribute && event.target.hasAttribute('data-media-pick')) refresh();
  });
  var allBox = document.getElementById('mediaPickAll');
  if (allBox) {
    allBox.addEventListener('change', function () {
      Array.prototype.forEach.call(document.querySelectorAll('[data-media-pick]'), function (box) { box.checked = allBox.checked; });
      refresh();
    });
  }
  // 批量移动: 与"移动目录"共用同一个端点与确认页, 只是这批对象由 paths 指定(不改名, 只换目录)
  if (moveBtn && MOVE) {
    moveBtn.addEventListener('click', function () {
      var list = picked();
      if (!list.length || list.length > MOVE_MAX) return;
      window.location = MOVE + '?action=move&paths=' + encodeURIComponent(JSON.stringify(list))
        + '&back=' + encodeURIComponent(window.location.pathname + window.location.search);
    });
  }
  refresh();
})();
