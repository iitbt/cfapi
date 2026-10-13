// 从 pages/dbTools.js 的内联模板字符串搬来的(2.5.0): 真文件才有语法检查,
// 模板字符串里反斜杠会被求值吃掉、反引号会直接截断脚本(2026-10-10 两次教训)。
// 原来写在模板里的 \\t / \\n / \\s / \\b 已还原成单反斜杠, 语义与改前一致。
(function () {
  // 结果直接进 innerHTML, 必须转义: 库里的标题等字段带 <img onerror> 就能在超管的会话里执行
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function copy(text, btn) {
    function done(ok) {
      if (!btn) return;
      var old = btn.innerHTML;
      btn.innerHTML = ok ? '已复制' : '复制失败';
      setTimeout(function () { btn.innerHTML = old; }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      return;
    }
    try {
      var area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      done(ok);
    } catch (error) { done(false); }
  }
  // ---- 成本与额度(2.2.9): 把每次响应的 D1 meta 累加到本机 localStorage(不上传、不落库) ----
  var COST_KEY = 'cf_db_tools_cost_v1';
  function costBook() {
    try { return JSON.parse(localStorage.getItem(COST_KEY) || '{}') || {}; } catch (error) { return {}; }
  }
  function costRender() {
    var el = document.querySelector('[data-cost-session]');
    if (!el) return;
    var book = costBook();
    el.textContent = book.queries
      ? ('读 ' + (book.read || 0) + ' 行 · 写 ' + (book.write || 0) + ' 行 · ' + book.queries + ' 次查询（含本屏渲染）')
      : '这一页还没执行过查询';
  }
  function costAdd(stats) {
    if (!stats) return;
    var book = costBook();
    book.read = Number(book.read || 0) + Number(stats.rowsRead || 0);
    book.write = Number(book.write || 0) + Number(stats.rowsWritten || 0);
    book.queries = Number(book.queries || 0) + 1;
    book.at = Date.now();
    try { localStorage.setItem(COST_KEY, JSON.stringify(book)); } catch (error) { /* 隐私模式写不了就只显示本次 */ }
    costRender();
  }
  (function initCost() {
    // 服务端渲染出来的这一屏(表详情/结构/字段总览)没有 JSON 响应可累加, 所以由页面把用量挂在这里
    var holder = document.querySelector('[data-page-cost]');
    if (holder) {
      try { costAdd(JSON.parse(holder.getAttribute('data-page-cost') || 'null')); } catch (error) { /* 忽略 */ }
    }
    costRender();
    var reset = document.querySelector('[data-cost-reset]');
    if (reset) {
      reset.addEventListener('click', function () {
        try { localStorage.removeItem(COST_KEY); } catch (error) { /* 忽略 */ }
        costRender();
      });
    }
  })();
  // 敏感列: 生成 INSERT/UPDATE / 行内编辑 时跳过(值已被服务端打码成 ***, 写回去会把真值覆盖掉)
  function sensitiveList() {
    var holder = document.querySelector('[data-sensitive-columns]');
    return (holder ? holder.getAttribute('data-sensitive-columns') : '').split(',').filter(Boolean);
  }
  function literal(value) {
    if (value === null) return 'NULL';
    if (typeof value === 'number') return String(value);
    return "'" + String(value).replace(/'/g, "''") + "'";
  }
  //: 参与生成 SQL 的列: 去掉注入用的 rowid 与敏感列(敏感列的值是 ***, 写回去会覆盖真值)
  function sqlKeys(row) {
    var sensitive = sensitiveList();
    return Object.keys(row).filter(function (key) {
      return key !== '__rowid' && key !== '__truncated' && sensitive.indexOf(key) < 0;
    });
  }
  function insertSql(table, row) {
    var keys = sqlKeys(row);
    return 'INSERT INTO ' + table + ' (' + keys.map(function (key) { return '"' + key + '"'; }).join(', ')
      + ') VALUES (' + keys.map(function (key) { return literal(row[key]); }).join(', ') + ');';
  }
  function updateSql(table, row, pkColumns) {
    var keys = sqlKeys(row);
    var pk = pkColumns || [];
    var where;
    if (pk.length) {
      where = pk.map(function (key) { return '"' + key + '" = ' + literal(row[key]); }).join(' AND ');
    } else if (row.__rowid !== undefined) {
      where = 'rowid = ' + literal(row.__rowid);
    } else {
      where = '/* 这张表没有主键也没有 rowid, 请自行补 WHERE */';
    }
    return 'UPDATE ' + table + ' SET ' + keys.map(function (key) { return '"' + key + '" = ' + literal(row[key]); }).join(', ')
      + ' WHERE ' + where + ';';
  }
  // 生成 UPDATE 只是把语句填进控制台(不直接执行): 写操作仍然走唯一那条被白名单与审计拦着的 exec
  function fillConsole(sql, btn) {
    var area = document.getElementById('sqlText');
    if (!area) { copy(sql, btn); return; }
    area.value = sql;
    area.focus();
    var card = document.getElementById('sqlCard');
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  //: 当前展开的那一行(行内不内嵌行数据, 这张卡片里的就是完整值)
  var fullRow = null;
  var rowCache = {};
  // 按 rowid 取单行完整数据(1 次查询, 同一行在同一页面里只取一次)
  function fetchRow(table, rowid, btn) {
    var key = table + ':' + rowid;
    if (rowCache[key]) return Promise.resolve(rowCache[key]);
    var old = btn ? btn.innerHTML : '';
    if (btn) btn.innerHTML = '取数…';
    return fetch('/admin/db_manage/table?name=' + encodeURIComponent(table) + '&rowid=' + encodeURIComponent(rowid),
      { headers: { accept: 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (btn) btn.innerHTML = old;
        if (!data || data.code !== 200) {
          var holder = document.getElementById('rowDetail');
          if (holder && btn) holder.innerHTML = '<div class="alert alert-warning py-2 mb-0">'
            + esc((data && data.msg) || '取数失败') + '</div>';
          return null;
        }
        rowCache[key] = data.data.row || {};
        return rowCache[key];
      })
      .catch(function () {
        if (btn) btn.innerHTML = old;
        var holder = document.getElementById('rowDetail');
        if (holder && btn) holder.innerHTML = '<div class="alert alert-warning py-2 mb-0">取数失败，请稍后重试</div>';
        return null;
      });
  }
  function renderFullRow(target) {
    var box = document.getElementById('rowDetail');
    if (!box || !fullRow) return;
    var json = JSON.stringify(fullRow.row, null, 2);
    box.innerHTML = '<div class="card border-primary"><div class="card-body">'
      + '<div class="d-flex flex-wrap align-items-center gap-2 mb-2"><b>完整行</b>'
      + '<span class="small text-muted">' + esc(fullRow.table) + ' · rowid ' + esc(fullRow.rowid) + '</span>'
      + '<span class="ms-auto d-flex flex-wrap gap-2">'
      + '<button type="button" class="btn btn-sm btn-outline-secondary" data-full-action="json">复制 JSON</button>'
      + '<button type="button" class="btn btn-sm btn-outline-secondary" data-full-action="insert">复制 INSERT</button>'
      + '<button type="button" class="btn btn-sm btn-outline-secondary" data-full-action="update">生成 UPDATE</button>'
      + '<button type="button" class="btn btn-sm btn-outline-secondary" data-full-action="close">收起</button>'
      + '</span></div><pre class="small mb-0" style="max-height:16rem;overflow:auto">' + esc(json) + '</pre>'
      + '<div class="small text-muted mt-2">这是按 rowid 取回来的完整值（含长文本）；列表页不透传整行数据，页面体积更小。</div>'
      + '</div></div>';
    if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  // ---- 写操作(2.2.9): 单行编辑/删除、批量删除都"生成一条 SQL → 走既有的 exec" ----
  // 不新增写接口的原因: 能改哪里、怎么改的口径只有一处(白名单业务表 + confirm=1 + 审计 + 用量回传)
  function runSql(sql, done) {
    fetch('/admin/db_manage/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: sql, confirm: '1' })
    }).then(function (res) { return res.json(); }).then(function (data) {
      if (data && data.data) costAdd(data.data.stats);
      done(data || {});
    }).catch(function () { done({ code: 0, msg: '请求失败，请稍后重试' }); });
  }
  function execMessage(data) {
    if (!data || data.code !== 200) {
      return (data && data.msg ? data.msg : '执行失败') + (data && data.detail ? '：' + data.detail : '');
    }
    var stats = data.data && data.data.stats;
    return '影响 ' + ((data.data && data.data.affected) || 0) + ' 行'
      + (stats && stats.costText ? ' · ' + stats.costText : '');
  }
  // 单行编辑: 界面只负责"生成一条 UPDATE", 保存时仍会弹出 SQL 供确认
  var editState = null;
  function safeColumn(name) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || '')); }
  function editorCard(table, rowid, row, pk) {
    var keys = Object.keys(row).filter(function (key) {
      return key !== '__rowid' && key !== '__truncated' && safeColumn(key) && sensitiveList().indexOf(key) < 0;
    });
    var inputs = keys.map(function (key) {
      var text = row[key] === null || row[key] === undefined ? '' : String(row[key]);
      return '<div class="row g-2 align-items-center mb-1">'
        + '<label class="col-auto col-form-label small"><code>' + esc(key) + '</code></label>'
        + '<div class="col"><input class="form-control form-control-sm font-monospace" data-edit-input="' + esc(key) + '" value="' + esc(text) + '"></div>'
        + '<div class="col-auto form-check"><input class="form-check-input" type="checkbox" data-edit-null="' + esc(key) + '" id="editnull-' + esc(key) + '">'
        + '<label class="form-check-label small" for="editnull-' + esc(key) + '">NULL</label></div>'
        + '</div>';
    }).join('');
    var pkCols = String(pk || '').split(',').filter(Boolean);
    var where = pkCols.length
      ? pkCols.map(function (key) { return '"' + key + '" = ' + literal(row[key]); }).join(' AND ')
      : 'rowid = ' + literal(Number(rowid));
    return '<div class="card border-primary"><div class="card-body">'
      + '<div class="d-flex flex-wrap align-items-center gap-2 mb-2"><b>编辑这一行</b>'
      + '<span class="small text-muted">' + esc(table) + ' · rowid ' + esc(rowid) + ' · 定位条件 ' + esc(where) + '</span></div>'
      + inputs
      + '<div class="d-flex flex-wrap align-items-center gap-2 mt-2">'
      + '<button type="button" class="btn btn-sm btn-primary" data-edit-save>保存（执行一条 UPDATE）</button>'
      + '<button type="button" class="btn btn-sm btn-outline-danger" data-edit-delete>删除这一行（执行一条 DELETE）</button>'
      + '<button type="button" class="btn btn-sm btn-outline-secondary" data-edit-cancel>取消</button>'
      + '<span class="small" data-edit-msg></span></div>'
      + '<div class="small text-muted mt-2">敏感列不参与编辑（值已打码）；空字符串与 NULL 是两件事，要 NULL 就勾上右边的框。'
      + '保存与删除都会先弹出要执行的 SQL 让你确认，执行结果里带影响行数与 D1 用量；每一步都进服务端审计。</div>'
      + '</div></div>';
  }
  function openEditor(table, rowid, row, pk) {
    var box = document.getElementById('rowEditor');
    if (!box) return;
    editState = { table: table, rowid: String(rowid), row: row, pk: pk };
    box.innerHTML = editorCard(table, rowid, row, pk);
    if (box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function closeEditor() {
    editState = null;
    var box = document.getElementById('rowEditor');
    if (box) box.innerHTML = '';
  }
  function editMessage(text) {
    var box = document.getElementById('rowEditor');
    var el = box ? box.querySelector('[data-edit-msg]') : null;
    if (el) el.textContent = text;
  }
  function editorSql(action) {
    var box = document.getElementById('rowEditor');
    if (!box || !editState) return '';
    var pkCols = String(editState.pk || '').split(',').filter(Boolean);
    // 定位条件用**取回时的原值**(不是在表单里改过的值), 否则改主键就会定位失败
    var where = pkCols.length
      ? pkCols.map(function (key) { return '"' + key + '" = ' + literal(editState.row[key]); }).join(' AND ')
      : 'rowid = ' + literal(Number(editState.rowid));
    if (action === 'delete') return 'DELETE FROM "' + editState.table + '" WHERE ' + where + ';';
    var inputs = Array.prototype.slice.call(box.querySelectorAll('[data-edit-input]'));
    var sets = inputs.map(function (input) {
      var key = input.getAttribute('data-edit-input');
      var nullBox = box.querySelector('[data-edit-null="' + key + '"]');
      return '"' + key + '" = ' + (nullBox && nullBox.checked ? 'NULL' : literal(input.value));
    });
    return 'UPDATE "' + editState.table + '" SET ' + sets.join(', ') + ' WHERE ' + where + ';';
  }
  function refreshRow(table, rowid, message) {
    delete rowCache[table + ':' + rowid];
    fetchRow(table, rowid, null).then(function (row) {
      if (!row) return;
      var tr = document.querySelector('tr[data-row-rowid="' + rowid + '"]');
      if (tr) {
        var tableEl = tr.closest ? tr.closest('table') : null;
        var keys = ((tableEl && tableEl.getAttribute('data-row-keys')) || '').split(',').filter(Boolean);
        var offset = tableEl && tableEl.getAttribute('data-selectable') === '1' ? 1 : 0;
        keys.forEach(function (key, index) {
          var cell = tr.children[index + offset];
          if (!cell) return;
          var text = row[key] === null || row[key] === undefined ? '' : String(row[key]);
          var shown = text.length > 120 ? text.slice(0, 120) + '…' : text;
          cell.textContent = shown || '—';
          if (text.length > 120) cell.setAttribute('title', text.slice(0, 200));
          else cell.removeAttribute('title');
        });
      }
      if (editState && editState.rowid === String(rowid)) {
        openEditor(table, rowid, row, editState.pk);
        // openEditor 会重画卡片, 所以回执要放在它后面(否则"影响几行"一闪就没)
        if (message) editMessage(message);
      }
    });
  }
  // 批量勾选: 取数(一条 rowid IN …) / 删除(一条 DELETE)
  function picks() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-row-pick]'))
      .filter(function (box) { return box.checked; })
      .map(function (box) { return box.value; });
  }
  function batchMessage(text) {
    var el = document.querySelector('[data-batch-msg]');
    if (el) el.textContent = text;
  }
  function syncSelection() {
    var chosen = picks().length;
    var count = document.querySelector('[data-selection-count]');
    if (count) count.textContent = '已选 ' + chosen + ' 行';
    Array.prototype.forEach.call(document.querySelectorAll('[data-batch-action]'), function (btn) {
      btn.disabled = chosen === 0;
    });
  }
  function batchTable() {
    var el = document.querySelector('table[data-table]');
    return el ? el.getAttribute('data-table') : '';
  }
  // ---- 通用复制按钮 + 行操作(复制 JSON/INSERT、生成 UPDATE、编辑、按需取完整行) ----
  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target) return;
    if (target.matches && target.matches('[data-row-pick]')) { syncSelection(); return; }
    if (target.matches && target.matches('[data-select-all]')) {
      Array.prototype.forEach.call(document.querySelectorAll('[data-row-pick]'), function (box) {
        box.checked = target.checked;
      });
      syncSelection();
    }
  });
  document.addEventListener('click', function (event) {
    var btn = event.target.closest ? event.target.closest('[data-copy]') : null;
    if (btn) { copy(btn.getAttribute('data-copy'), btn); return; }
    // 批量操作(取数/删除都只有一条 SQL)
    var batchBtn = event.target.closest ? event.target.closest('[data-batch-action]') : null;
    if (batchBtn) {
      var table = batchTable();
      var chosen = picks();
      if (!table || !chosen.length) return;
      var batchAction = batchBtn.getAttribute('data-batch-action');
      if (batchAction === 'delete') {
        var delSql = 'DELETE FROM "' + table + '" WHERE rowid IN (' + chosen.join(', ') + ');';
        if (!window.confirm('将删除 ' + chosen.length + ' 行（不可恢复，且只影响这些 rowid）：\n\n' + delSql + '\n\n确认执行？')) return;
        batchMessage('执行中…');
        runSql(delSql, function (data) {
          batchMessage(execMessage(data));
          if (!data || data.code !== 200) return;
          chosen.forEach(function (rowid) {
            var tr = document.querySelector('tr[data-row-rowid="' + rowid + '"]');
            if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
            delete rowCache[table + ':' + rowid];
          });
          var all = document.querySelector('[data-select-all]');
          if (all) all.checked = false;
          syncSelection();
          closeEditor();
        });
        return;
      }
      batchMessage('取数中…');
      fetch('/admin/db_manage/table?name=' + encodeURIComponent(table) + '&rowids=' + encodeURIComponent(chosen.join(',')),
        { headers: { accept: 'application/json' } })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (!data || data.code !== 200) { batchMessage((data && data.msg) || '取数失败'); return; }
          costAdd(data.data.stats);
          var rows = data.data.rows || [];
          if (batchAction === 'copy-tsv') {
            var keys = data.data.row_keys || (rows[0] ? Object.keys(rows[0]) : []);
            var lines = [keys.join('\t')].concat(rows.map(function (row) {
              return keys.map(function (key) {
                return String(row[key] === null || row[key] === undefined ? '' : row[key]).replace(/\t/g, ' ').replace(/\n/g, ' ');
              }).join('\t');
            }));
            copy(lines.join('\n'), batchBtn);
          } else {
            copy(JSON.stringify(rows, null, 2), batchBtn);
          }
          batchMessage('已取回 ' + rows.length + ' 行'
            + (data.data.stats && data.data.stats.costText ? ' · ' + data.data.stats.costText : ''));
        })
        .catch(function () { batchMessage('取数失败，请稍后重试'); });
      return;
    }
    // 单行编辑卡片里的按钮
    var editBtn = event.target.closest ? event.target.closest('[data-edit-save],[data-edit-delete],[data-edit-cancel]') : null;
    if (editBtn) {
      if (editBtn.hasAttribute('data-edit-cancel')) { closeEditor(); return; }
      if (!editState) return;
      var action = editBtn.hasAttribute('data-edit-delete') ? 'delete' : 'update';
      var editSql = editorSql(action);
      var tip = action === 'delete'
        ? '将删除这一行（不可恢复）：\n\n' + editSql + '\n\n确认执行？'
        : '将执行这条 UPDATE（只影响这一行）：\n\n' + editSql + '\n\n确认执行？';
      if (!window.confirm(tip)) return;
      var target = editBtn;
      editMessage('执行中…');
      runSql(editSql, function (data) {
        var table = editState.table;
        var rowid = editState.rowid;
        editMessage(execMessage(data));
        if (!data || data.code !== 200) return;
        if (action === 'delete') {
          var tr = document.querySelector('tr[data-row-rowid="' + rowid + '"]');
          if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
          delete rowCache[table + ':' + rowid];
          closeEditor();
          batchMessage('已删除 1 行 · ' + execMessage(data));
          return;
        }
        refreshRow(table, rowid, '已保存 · ' + execMessage(data));
      });
      if (target) target.blur();
      return;
    }
    // 完整行卡片里的按钮
    var fullBtn = event.target.closest ? event.target.closest('[data-full-action]') : null;
    if (fullBtn) {
      if (!fullRow) return;
      var fullAction = fullBtn.getAttribute('data-full-action');
      if (fullAction === 'json') { copy(JSON.stringify(fullRow.row, null, 2), fullBtn); return; }
      if (fullAction === 'insert') { copy(insertSql(fullRow.table, fullRow.row), fullBtn); return; }
      if (fullAction === 'update') { fillConsole(updateSql(fullRow.table, fullRow.row, fullRow.pk), fullBtn); return; }
      if (fullAction === 'close') {
        var box = document.getElementById('rowDetail');
        if (box) box.innerHTML = '';
        fullRow = null;
      }
      return;
    }
    var rowBtn = event.target.closest ? event.target.closest('[data-row-action]') : null;
    if (!rowBtn) return;
    var table = rowBtn.getAttribute('data-table') || '';
    var rowid = rowBtn.getAttribute('data-rowid') || '';
    var action = rowBtn.getAttribute('data-row-action');
    var pk = (rowBtn.getAttribute('data-pk') || '').split(',').filter(Boolean);
    // 行内不再内嵌整行数据: 四个动作都先按 rowid 取这一行(1 次查询, 同一页面同一行只取一次)
    fetchRow(table, rowid, rowBtn).then(function (row) {
      if (!row) return;
      if (action === 'json') { copy(JSON.stringify(row, null, 2), rowBtn); return; }
      if (action === 'insert') { copy(insertSql(table, row), rowBtn); return; }
      if (action === 'update') { fillConsole(updateSql(table, row, pk), rowBtn); return; }
      if (action === 'edit') { openEditor(table, rowid, row, pk.join(',')); return; }
      fullRow = { table: table, rowid: rowid, row: row, pk: pk.join(',') };
      renderFullRow(rowBtn);
    });
  });
  // ---- 表名本地筛选(不联网) ----
  var filterInput = document.querySelector('[data-filter-tables]');
  if (filterInput) {
    filterInput.addEventListener('input', function () {
      var keyword = filterInput.value.trim().toLowerCase();
      Array.prototype.forEach.call(document.querySelectorAll('[data-table-row]'), function (row) {
        var name = (row.getAttribute('data-table-row') || '').toLowerCase();
        row.style.display = !keyword || name.indexOf(keyword) >= 0 ? '' : 'none';
      });
    });
  }
  // ---- SQL 控制台 ----
  var form = document.getElementById('sqlForm');
  if (!form) return;
  var out = document.getElementById('sqlOut');
  var box = document.getElementById('sqlResult');
  var area = document.getElementById('sqlText');
  var HISTORY_KEY = 'cf_db_tools_history_v1';
  var page = 1;
  var current = { rows: [], keys: [] };

  function history() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (error) { return []; }
  }
  function remember(sql) {
    try {
      var list = history().filter(function (item) { return item !== sql; });
      list.unshift(sql);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 10)));
      renderHistory();
    } catch (error) { /* 隐私模式等场景忽略 */ }
  }
  function renderHistory() {
    var holder = document.querySelector('[data-sql-history]');
    if (!holder) return;
    var list = history();
    holder.innerHTML = list.length ? list.map(function (sql, index) {
      return '<button type="button" class="btn btn-sm btn-outline-secondary" data-history="'
        + index + '" title="' + esc(sql) + '">' + esc(sql.slice(0, 24)) + (sql.length > 24 ? '…' : '') + '</button>';
    }).join('') : '<span class="small text-muted">（还没有记录，执行过的语句会留在本机浏览器里）</span>';
  }
  renderHistory();
  document.addEventListener('click', function (event) {
    var btn = event.target.closest ? event.target.closest('[data-history]') : null;
    if (!btn || !area) return;
    var list = history();
    var picked = list[Number(btn.getAttribute('data-history'))];
    if (picked) area.value = picked;
  });
  var preset = document.querySelector('[data-sql-preset]');
  if (preset) {
    preset.addEventListener('change', function () {
      if (preset.value && area) area.value = preset.value;
    });
  }
  var clear = document.querySelector('[data-sql-clear]');
  if (clear) {
    clear.addEventListener('click', function () {
      if (area) area.value = '';
      if (box) box.innerHTML = '';
      if (out) out.textContent = '';
    });
  }

  function renderResult() {
    if (!box) return;
    if (!current.rows.length) { box.innerHTML = ''; return; }
    var perPage = 50;
    var pages = Math.max(1, Math.ceil(current.rows.length / perPage));
    if (page > pages) page = pages;
    var slice = current.rows.slice((page - 1) * perPage, page * perPage);
    var head = current.keys.map(function (key) { return '<th>' + esc(key) + '</th>'; }).join('');
    var body = slice.map(function (row) {
      return '<tr>' + current.keys.map(function (key) { return '<td>' + esc(row[key]) + '</td>'; }).join('') + '</tr>';
    }).join('');
    var pager = pages > 1
      ? '<div class="d-flex align-items-center gap-2 mt-2"><button type="button" class="btn btn-sm btn-outline-secondary" data-result-page="prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button><span class="small text-muted">第 ' + page + '/' + pages + ' 页</span><button type="button" class="btn btn-sm btn-outline-secondary" data-result-page="next"' + (page >= pages ? ' disabled' : '') + '>下一页</button></div>'
      : '';
    var statsLine = current.stats
      ? '<span class="small text-muted align-self-center">本次查询：读 ' + esc(current.stats.rowsRead) + ' 行 · 写 '
        + esc(current.stats.rowsWritten) + ' 行 · ' + esc(current.stats.durationMs) + ' ms'
        + '（rows_read 明显偏大 = 全表扫描，考虑加索引或 LIMIT）</span>'
      : '';
    box.innerHTML = '<div class="d-flex flex-wrap gap-2 mb-2">'
      + '<button type="button" class="btn btn-sm btn-outline-secondary" data-result-copy="tsv">复制为 TSV（可直接粘进表格软件）</button>'
      + '<button type="button" class="btn btn-sm btn-outline-secondary" data-result-copy="json">复制为 JSON</button>'
      + statsLine
      + '</div><div class="table-responsive"><table class="table table-sm table-bordered mb-0"><thead><tr>'
      + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' + pager;
  }
  document.addEventListener('click', function (event) {
    var pager = event.target.closest ? event.target.closest('[data-result-page]') : null;
    if (pager) {
      page += pager.getAttribute('data-result-page') === 'next' ? 1 : -1;
      renderResult();
      return;
    }
    var copier = event.target.closest ? event.target.closest('[data-result-copy]') : null;
    if (!copier) return;
    if (copier.getAttribute('data-result-copy') === 'json') {
      copy(JSON.stringify(current.rows, null, 2), copier);
      return;
    }
    var lines = [current.keys.join('\t')].concat(current.rows.map(function (row) {
      return current.keys.map(function (key) {
        return String(row[key] === null || row[key] === undefined ? '' : row[key]).replace(/\t/g, ' ').replace(/\n/g, ' ');
      }).join('\t');
    }));
    copy(lines.join('\n'), copier);
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var sql = (area && area.value || '').trim();
    if (!sql) { out.textContent = '请输入要执行的 SQL'; return; }
    var write = /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)/i.test(sql);
    var dangerous = /^\s*(UPDATE|DELETE)/i.test(sql) && !/\bwhere\b/i.test(sql);
    if (write && !window.confirm('这是写操作（会改动数据），确认执行？')) return;
    if (dangerous && !window.confirm('这条语句没有 WHERE，会改动/删除整表数据。确定继续？')) return;
    out.textContent = '执行中…';
    box.innerHTML = '';
    fetch('/admin/db_manage/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: sql, confirm: write ? '1' : '' })
    }).then(function (res) { return res.json(); }).then(function (data) {
      remember(sql);
      if (data && data.data) costAdd(data.data.stats);
      // msg 里已经带了 D1 的用量(读 N 行 · 写 N 行 · N ms) —— 见 lib/dbTool.js 的 statsOf
      out.textContent = (data.msg || '') + (data.data && data.data.warning ? ' ⚠ ' + data.data.warning : '');
      if (data.detail) {
        box.innerHTML = '<div class="alert alert-warning py-2 mb-0"><div class="small mb-1">数据库返回：</div><code>'
          + esc(data.detail) + '</code></div>';
      }
      var rows = (data.data && data.data.rows) || [];
      if (!rows.length) {
        current = { rows: [], keys: [], stats: (data.data && data.data.stats) || null };
        return;
      }
      current = { rows: rows, keys: Object.keys(rows[0]), stats: (data.data && data.data.stats) || null };
      page = 1;
      renderResult();
    }).catch(function () { out.textContent = '请求失败，请稍后重试'; });
  });
})();
