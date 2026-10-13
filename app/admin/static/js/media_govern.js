// 从 pages/mediaGovern.js 的内联模板字符串搬来的(2.5.0): 真文件才有语法检查,
// 模板字符串里反斜杠会被求值吃掉、反引号会直接截断脚本(2026-10-10 两次教训)。
// 两个常量改由页面注入(见 pages/mediaGovern.js 的 __mediaGovernCfg), 不再写死在脚本里。
  (function () {
    'use strict';
    // 两个常量由页面注入(见 __mediaGovernCfg), 不写死在脚本里
    var CFG = window.__mediaGovernCfg || {};
    var BATCH_MAX = CFG.batchMax;
    var UPLOAD = CFG.uploadUrl;
    var pickers = document.querySelectorAll('input[data-purpose]');   // 4 个入口: 图片/视频 × 文件/文件夹
    var startBtn = document.getElementById('mediaUploadStart');
    var clearBtn = document.getElementById('mediaUploadClear');
    var bar = document.getElementById('mediaUploadBar');
    var overallEl = document.getElementById('mediaUploadOverall');
    var currentEl = document.getElementById('mediaUploadCurrent');
    var failedEl = document.getElementById('mediaUploadFailed');
    var doneEl = document.getElementById('mediaUploadDone');
    var queue = [];
    var running = false;
    var totalBytes = 0;
    var doneBytes = 0;

    function mb(value) { return (Number(value || 0) / 1024 / 1024).toFixed(1) + ' MB'; }
    // 目标路径(2.4.3/2.4.4): 每个入口一个下拉, 默认就是该入口的素材根(image/ 或 video/)
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
    // 前后端都校验(任务要求): 前端先拦一道, 免得整批文件各失败一次。
    // 只拦两条最要命的(必须是本入口的根目录或它下面的子目录、不含两个点), 其余(分隔符归一/特殊字符/超长)以后端为准 ——
    // 这段脚本是模板字符串生成的: 反斜杠会被转义吃掉、反引号会直接截断脚本(2026-10-10 两次教训), 注释里都别写。
    // 根目录的提交值就是斜杠一个字符, 前后端都认(见 lib/mediaUpload 的 safeTargetDir)。
    function dirProblem() {
      var rows = [{ purpose: 'cover', title: '图片', root: 'image/' }, { purpose: 'video', title: '视频', root: 'video/' }];
      for (var index = 0; index < rows.length; index += 1) {
        var value = dirOf(rows[index].purpose);
        if (!value || value === '/') continue;
        if (value.indexOf('..') !== -1) return '目标路径不能包含两个点：请改成 ' + rows[index].root + ' 下面的普通目录';
        if (value.indexOf(rows[index].root) !== 0) return rows[index].title + '的目标路径必须以 ' + rows[index].root + ' 开头';
      }
      return '';
    }
    function mode() {
      var picked = document.querySelector('input[name=mediaNameMode]:checked');
      return picked ? picked.value : 'auto';
    }
    // 文件夹上传(2.4.2): webkitRelativePath 形如 "顶层目录/子目录/文件" —— **整棵树原样带上**(含选中的那层),
    // 服务端按它建层级(图片落 image/、视频落 video/); 普通"选择文件"没有这个字段 → 直接落根目录。
    // 分隔符与非法字符一律交给服务端的 safeRelPath 清洗(它已做反斜杠归一), 这里不重复一遍 ——
    // 这是一段"用模板字符串生成的脚本", 在这里写正则里的反斜杠会被多层转义吃掉(2026-10-10 踩过: 整段脚本因此语法错)。
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
    }
    function renderFailed() {
      failedEl.innerHTML = '';
      queue.forEach(function (item) {
        if (item.state !== 'fail') return;
        var li = document.createElement('li');
        li.className = 'text-danger';
        li.appendChild(document.createTextNode((item.rel || item.file.name) + ' — ' + (item.message || '上传失败')));
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn-sm btn-outline-secondary ms-2';
        retry.textContent = '重试';
        retry.addEventListener('click', function () {
          item.state = 'wait';
          item.message = '';
          render();
          renderFailed();
          run();
        });
        var skip = document.createElement('button');
        skip.type = 'button';
        skip.className = 'btn btn-sm btn-link text-muted ms-1';
        skip.textContent = '跳过';
        skip.addEventListener('click', function () {
          item.state = 'skip';
          render();
          renderFailed();
        });
        li.appendChild(retry);
        li.appendChild(skip);
        failedEl.appendChild(li);
      });
    }
    function addFiles(list, purpose) {
      if (!list || !list.length) return;
      for (var index = 0; index < list.length; index += 1) {
        var file = list[index];
        // purpose 跟着文件走: 两种类型可以混在一个队列里, 各传各的目录
        queue.push({ file: file, rel: relOf(file), purpose: purpose, state: 'wait', message: '' });
        totalBytes += file.size || 0;
      }
      doneEl.innerHTML = '';
      render();
    }
    // 一个文件一个请求(顺序上传): 进度来自 XHR 的 upload.onprogress —— 浏览器拿不到服务端处理进度
    function send(item, onProgress) {
      return new Promise(function (resolve) {
        var data = new FormData();
        data.set('file', item.file);
        // 2.4.1: 类型由入口决定(图片入口 cover→image/、视频入口 video→video/),
        // 沿用既有的 purpose 规则; 服务端仍按文件头校验, 类型对不上会拒
        data.set('purpose', item.purpose);
        data.set('name_mode', mode());
        // 2.4.2: 目录结构两种命名模式都保留 → rel_path 不再只在"保留原名"时发
        if (item.rel) data.set('rel_path', item.rel);
        // 2.4.3: 目标路径(默认 image/ 或 video/, 可改成其下的子目录); 不填就不发, 服务端用默认
        var target = dirOf(item.purpose);
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
      // 目标路径先过一遍(前后端都校验): 有问题就整批不开跑, 而不是让每个文件各失败一次
      var problem = dirProblem();
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
          renderFailed();
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
    // 目标路径下拉: 选「其它」时露出手动输入框(两个入口各一个)
    Array.prototype.forEach.call(document.querySelectorAll('select[data-manual]'), function (select) {
      select.addEventListener('change', function () { syncManual(select); });
    });
    if (startBtn) startBtn.addEventListener('click', run);
    if (clearBtn) clearBtn.addEventListener('click', function () {
      if (running) return;
      queue = [];
      totalBytes = 0;
      doneBytes = 0;
      currentEl.textContent = '';
      failedEl.innerHTML = '';
      doneEl.innerHTML = '';
      render();
    });
    render();

    var batchForm = document.getElementById('mediaBatchForm');
    if (!batchForm) return;
    var hidden = document.getElementById('mediaBatchPaths');
    var countEl = document.getElementById('mediaBatchCount');
    var button = document.getElementById('mediaBatchDelete');
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
    refresh();
  })();
