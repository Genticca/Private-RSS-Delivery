(() => {
  const state = { logType: 'delivery', logBefore: { delivery: null, fetch: null, translation: null }, logsPaused: false, logFilterError: false, seenLogs: new Set(), previewVersion: 0, logVersion: 0, logsLoading: false, pendingLogs: [] };

  document.addEventListener('DOMContentLoaded', () => {
    highlightActiveNav();
    applyCurrentSelections();
    initTemplateEditor();
    initLogs();
    bindGlobalErrors();
    startSystemStatusHeartbeat();
    initWorkspace();
    // htmx로 주입된 콘텐츠(예: 소스 추가/수정 모달)에도 저장값 선택 상태를 재적용한다.
    document.body.addEventListener('htmx:afterSwap', (event) => {
      applyCurrentSelections(event.target);
      prepareSourceDialog();
      formatTimes();
      filterSources();
    });
    document.body.addEventListener('htmx:oobAfterSwap', formatTimes);
  });

  function initWorkspace() {
    prepareSourceDialog();
    formatTimes();
    const mobileNav = window.matchMedia('(max-width: 760px)');
    mobileNav.addEventListener('change', () => toggleNav(false));
    toggleNav(false);
    document.querySelector('[data-toggle-nav]')?.addEventListener('click', () => toggleNav(true));
    document.querySelector('[data-close-nav]')?.addEventListener('click', () => toggleNav(false));
    document.querySelector('[data-table-search]')?.addEventListener('input', filterSources);
    document.querySelector('[data-source-filter]')?.addEventListener('change', filterSources);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        toggleNav(false);
        document.querySelectorAll('.row-menu[open]').forEach((menu) => { menu.open = false; });
      }
    });
    document.addEventListener('change', (event) => {
      const input = event.target;
      if (input.matches('[data-boolean]')) {
        const hidden = input.form?.querySelector('input[type="hidden"][name="' + input.dataset.boolean + '"]');
        if (hidden) hidden.value = String(input.checked);
      }
      if (input.name === 'clearWebhook' && input.form?.matches('[data-group-form]')) {
        input.form.elements.webhookUrl.disabled = input.checked;
      }
    });
    document.addEventListener('click', (event) => {
      const open = event.target.closest('[data-open-dialog]');
      if (open?.dataset.openDialog === 'new-group-modal') void openGroupDialog().catch(showError);
      else if (open) document.getElementById(open.dataset.openDialog)?.showModal();
      const editGroup = event.target.closest('[data-edit-group]');
      if (editGroup) {
        editGroup.disabled = true;
        void openGroupDialog(editGroup.dataset.editGroup).catch(showError).finally(() => { editGroup.disabled = false; });
      }
      const close = event.target.closest('[data-close-dialog]');
      if (close) close.closest('dialog')?.close();
      if (event.target instanceof HTMLDialogElement) {
        const rect = event.target.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
      }
      document.querySelectorAll('.row-menu[open]').forEach((menu) => {
        if (!menu.contains(event.target) || event.target.closest('.row-menu-content')) menu.open = false;
      });
    });
    document.addEventListener('toggle', (event) => {
      const menu = event.target;
      if (!menu.matches?.('.row-menu[open]')) return;
      const trigger = menu.querySelector('summary').getBoundingClientRect();
      const content = menu.querySelector('.row-menu-content');
      content.style.right = Math.max(12, window.innerWidth - trigger.right) + 'px';
      content.style.top = Math.min(trigger.bottom + 5, Math.max(12, window.innerHeight - content.offsetHeight - 12)) + 'px';
    }, true);
    document.body.addEventListener('htmx:afterRequest', (event) => {
      if (!event.detail.successful || event.detail.xhr.status < 200 || event.detail.xhr.status >= 300) return;
      const form = event.detail.elt;
      if (form.matches?.('[data-group-form]')) {
        form.closest('dialog')?.close();
        flash(form.dataset.groupId ? '발신 그룹 설정을 저장했습니다.' : '발신 그룹을 추가했습니다.');
      }
      if (form.matches?.('[data-close-on-success]')) {
        form.closest('dialog')?.close();
        form.reset();
      }
      document.querySelectorAll('#group-table, #template-table').forEach((table) => {
        if (table.querySelector('[data-id]')) table.querySelector('[data-empty-row]')?.remove();
      });
      if (event.detail.requestConfig?.verb !== 'get') {
        const response = event.detail.xhr?.responseText || '';
        const message = new DOMParser().parseFromString(response, 'text/html').querySelector('.flash');
        if (message) flash(message.textContent.trim());
        else if (form.id === 'template-form') flash('변경사항을 저장했습니다.');
      }
    });
    new MutationObserver(filterSources).observe(document.getElementById('source-table') || document.createElement('div'), { childList: true });
  }

  function toggleNav(open) {
    const mobile = window.matchMedia('(max-width: 760px)').matches;
    document.body.classList.toggle('nav-open', open);
    document.querySelector('[data-close-nav]').hidden = !open;
    document.querySelector('[data-toggle-nav]')?.setAttribute('aria-expanded', String(open));
    const sidebar = document.getElementById('main-sidebar');
    sidebar.inert = mobile && !open;
    if (mobile && !open) sidebar.setAttribute('aria-hidden', 'true');
    else sidebar.removeAttribute('aria-hidden');
    if (open) document.querySelector('.sidebar .active')?.focus();
  }

  async function openGroupDialog(id) {
    const dialog = document.getElementById('new-group-modal');
    const form = dialog.querySelector('form');
    const group = id ? (await fetchJson('/api/groups')).find((entry) => String(entry.id) === String(id)) : null;
    if (id && !group) throw new Error('발신 그룹을 찾을 수 없습니다. 목록을 새로고침해 주세요.');
    form.reset();
    form.querySelectorAll('[data-htmx-inline-error]').forEach((el) => el.remove());
    form.dataset.groupId = group ? String(group.id) : '';
    form.elements.name.value = group?.name || '';
    form.elements.webhookName.value = group?.webhookName || '';
    form.elements.webhookAvatarUrl.value = group?.webhookAvatarUrl || '';
    form.elements.webhookUrl.value = '';
    form.elements.webhookUrl.disabled = false;
    form.elements.clearWebhook.checked = false;
    dialog.querySelector('#group-dialog-title').textContent = group ? '발신 그룹 설정' : '새 발신 그룹';
    dialog.querySelector('[data-group-eyebrow]').textContent = group ? 'GROUP SETTINGS' : 'NEW CONNECTION';
    dialog.querySelector('[data-group-submit]').textContent = group ? '변경사항 저장' : '그룹 만들기';
    dialog.querySelector('[data-group-webhook-help]').textContent = group ? '비워 두면 기존 웹훅을 유지합니다.' : '나중에 연결할 수도 있습니다.';
    dialog.querySelector('[data-group-current-webhook]').hidden = !group?.hasWebhook;
    dialog.querySelector('[data-group-webhook-label]').textContent = group?.maskedWebhookUrl || '';
    dialog.querySelector('[data-group-clear-webhook]').hidden = !group?.hasWebhook;
    dialog.querySelector('[data-group-edit-note]').hidden = !group;
    form.removeAttribute(group ? 'hx-post' : 'hx-patch');
    form.setAttribute(group ? 'hx-patch' : 'hx-post', group ? '/api/groups/' + group.id : '/api/groups');
    form.setAttribute('hx-target', group ? '#group-' + group.id : '#group-table');
    form.setAttribute('hx-swap', group ? 'outerHTML' : 'beforeend');
    window.htmx.process(form);
    dialog.showModal();
  }

  function prepareSourceDialog() {
    const dialog = document.querySelector('dialog[data-page="source-form"]');
    if (!dialog || dialog.dataset.initialized) return;
    dialog.dataset.initialized = 'true';
    const selector = dialog.querySelector('[data-channel-type]');
    const form = dialog.querySelector('form');
    const clears = document.createElement('div');
    clears.hidden = true;
    form.append(clears);
    selector.value = form.elements.threadId.value ? 'thread' : (form.elements.threadName.value || form.elements.appliedTags.value) ? 'forum' : 'text';
    const update = () => {
      clears.replaceChildren();
      dialog.querySelectorAll('[data-channel-section]').forEach((section) => {
        const active = section.dataset.channelSection === selector.value;
        section.hidden = !active;
        section.querySelectorAll('input').forEach((input) => {
          input.disabled = !active;
          if (!active) {
            const empty = document.createElement('input');
            empty.type = 'hidden';
            empty.name = input.name;
            empty.value = '';
            clears.append(empty);
          }
        });
      });
    };
    selector.addEventListener('change', update);
    update();
    dialog.addEventListener('close', () => {
      const mount = document.getElementById('source-modal-mount');
      if (mount.contains(dialog)) mount.replaceChildren();
      else window.location.assign('/sources');
    });
    dialog.showModal();
  }

  function filterSources() {
    const table = document.getElementById('source-table');
    if (!table) return;
    const search = (document.querySelector('[data-table-search]')?.value || '').trim().toLocaleLowerCase();
    const filter = document.querySelector('[data-source-filter]')?.value || 'all';
    const rows = Array.from(table.querySelectorAll('tr[data-id]'));
    rows.forEach((row) => {
      const statusMatch = filter === 'all' || (filter === 'enabled' && row.dataset.enabled === 'true') ||
        (filter === 'disabled' && row.dataset.enabled === 'false') || (filter === 'error' && row.dataset.error === 'true');
      row.hidden = !statusMatch || !(row.dataset.search || '').toLocaleLowerCase().includes(search);
    });
    const empty = document.querySelector('[data-no-results="source-table"]');
    if (empty) empty.hidden = !rows.length || rows.some((row) => !row.hidden);
    const count = document.querySelector('[data-source-count]');
    if (count) count.textContent = rows.length;
    if (!rows.length && !table.querySelector('[data-empty-row]')) {
      table.innerHTML = '<tr data-empty-row><td colspan="6"><div class="empty-state"><h3>연결된 소스가 없습니다</h3><p>위의 소스 추가 버튼으로 새 피드를 연결하세요.</p></div></td></tr>';
    }
  }

  function formatTimes() {
    document.querySelectorAll('[data-format-time]').forEach((el) => { el.textContent = fmtKst(el.getAttribute('datetime')); });
    const labels = { held: '검토 대기', unknown: '결과 불명', uneditable: '수정 불가', pending: '발송 대기', running: '처리 중', succeeded: '완료', cancelled: '보관 / 취소', failed: '실패' };
    document.querySelectorAll('[data-job-state]').forEach((el) => { el.textContent = labels[el.dataset.jobState] || el.dataset.jobState; });
    const modelLabels = { ready: '사용 가능', 'missing-key': 'API 키 필요', 'invalid-key': 'API 키 확인 필요', cooldown: '키 대기 중' };
    document.querySelectorAll('[data-model-state]').forEach((el) => { el.textContent = modelLabels[el.dataset.modelState] || el.dataset.modelState; });
    const keyLabels = { missing: '미설정', ready: '사용 가능', cooldown: '일시 대기' };
    document.querySelectorAll('[data-model-key-state]').forEach((el) => { el.textContent = keyLabels[el.dataset.modelKeyState] || el.dataset.modelKeyState; });
    document.querySelectorAll('[data-active-model-key]').forEach((el) => { el.textContent = { primary: '기본 키', fallback: '대체 키' }[el.dataset.activeModelKey] || '사용 가능한 키 없음'; });
  }

  function highlightActiveNav() {
    const path = window.location.pathname;
    let activeId = 'nav-dashboard';
    if (path.startsWith('/sources')) activeId = 'nav-sources';
    else if (path.startsWith('/groups')) activeId = 'nav-groups';
    if (path.startsWith('/templates')) activeId = 'nav-templates';
    else if (path.startsWith('/logs')) activeId = 'nav-logs';
    else if (path.startsWith('/model')) activeId = 'nav-model';
    else if (path.startsWith('/delivery-jobs')) activeId = 'nav-delivery-jobs';
    
    document.querySelectorAll('.sidebar-nav .nav-item').forEach((el) => {
      if (el.id === activeId) {
        el.classList.add('active');
        el.setAttribute('aria-current', 'page');
        document.getElementById('page-breadcrumb').textContent = el.textContent.trim();
        document.title = el.textContent.trim() + ' · RSS Bridge';
      } else {
        el.classList.remove('active');
      }
    });
  }

  function applyCurrentSelections(root) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    scope.querySelectorAll('select[data-current]').forEach((select) => {
      const current = select.getAttribute('data-current');
      if (current) select.value = current;
    });
    scope.querySelectorAll('[data-selected-groups]').forEach((fieldset) => {
      const selected = new Set((fieldset.getAttribute('data-selected-groups') || '').split(',').map((value) => value.trim()).filter(Boolean));
      fieldset.querySelectorAll('input[type="checkbox"][name="groupIds"]').forEach((input) => { input.checked = selected.has(input.value); });
    });
  }

  function initTemplateEditor() {
    const root = document.querySelector('[data-page="template-editor"]');
    if (!root) return;
    const textarea = document.getElementById('template-body');
    const editor = window.CodeMirror ? window.CodeMirror.fromTextArea(textarea, {
      mode: { name: 'javascript', json: true },
      readOnly: root.dataset.readonly === 'true',
      lineNumbers: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-lint-markers'],
      lint: { getAnnotations: templateJsonLint }
    }) : { getValue: () => textarea.value, setValue: (value) => { textarea.value = value; }, save: () => undefined, on: (_event, handler) => textarea.addEventListener('input', handler), replaceSelection: (value) => { textarea.value += value; } };
    const preview = debounce(() => renderPreview(editor), 300);
    editor.on('change', preview);
    document.querySelectorAll('[name="previewMode"], #preview-source').forEach((el) => el.addEventListener('change', preview));
    document.querySelectorAll('[data-insert-var]').forEach((button) => button.addEventListener('click', () => editor.replaceSelection(`{{json ${button.getAttribute('data-insert-var')}}}`)));
    document.getElementById('template-form')?.addEventListener('submit', () => editor.save?.(), { capture: true });
    void renderPreview(editor);
  }

  function templateJsonLint(text) {
    try {
      JSON.parse(preprocessTemplateForJsonLint(text));
      return [];
    } catch (error) {
      const index = syntaxErrorIndex(error);
      const from = indexToPos(text, index ?? 0);
      return [{ from, to: from, message: error instanceof Error ? error.message : String(error), severity: 'error' }];
    }
  }

  function preprocessTemplateForJsonLint(text) {
    return text
      .replace(/{{!.*?}}/gs, '')
      .replace(/{{\s*#[^}]+}}/g, '')
      .replace(/{{\s*\/[^}]+}}/g, '')
      .replace(/{{\s*else\s*}}/g, '')
      .replace(/{{\s*json\b[^}]*}}/g, '"template-value"')
      .replace(/{{\s*stageColor\b[^}]*}}/g, '5793266')
      .replace(/{{\s*(?:truncate|eq)\b[^}]*}}/g, '"template-value"')
      .replace(/{{\s*[^}]+}}/g, '"template-value"');
  }

  function syntaxErrorIndex(error) {
    const match = error instanceof Error ? /position (\d+)/i.exec(error.message) : null;
    return match ? Number(match[1]) : null;
  }

  function indexToPos(text, index) {
    const before = text.slice(0, Math.max(0, index));
    const lines = before.split('\n');
    return window.CodeMirror.Pos(lines.length - 1, lines[lines.length - 1].length);
  }

  async function renderPreview(editor) {
    const version = ++state.previewVersion;
    const mode = document.querySelector('[name="previewMode"]:checked')?.value || 'sample';
    const sourceId = document.getElementById('preview-source')?.value || undefined;
    const templateBody = editor.getValue();
    const target = document.getElementById('preview');
    if (!target) return;
    const result = await fetchJson('/api/preview', { method: 'POST', body: { templateBody, mode, sourceId } });
    if (version !== state.previewVersion) return;
    if (!result.ok) {
      target.innerHTML = `<div class="form-error">${result.errors.map((e) => `${escapeHtml(e.stage)}: ${escapeHtml(e.message)} ${escapeHtml(e.path || '')}`).join('<br>')}</div>`;
      return;
    }
    target.innerHTML = renderDiscordPayload(result.payload);
  }

  function renderDiscordPayload(payload) {
    const username = escapeHtml(payload.username || 'RSS Bridge');
    const avatarUrl = payload.avatar_url ? escapeHtml(payload.avatar_url) : null;
    const content = payload.content ? escapeHtml(payload.content) : '';
    const embeds = payload.embeds || [];
    
    const now = new Date();
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? '오후' : '오전';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const timeStr = `오늘 ${ampm} ${hours}:${minutes}`;
    
    const avatarHtml = avatarUrl 
      ? `<img class="discord-avatar" src="${avatarUrl}" alt="Avatar">`
      : `<div class="discord-avatar-default">🤖</div>`;
      
    let contentHtml = '';
    if (content) {
      contentHtml = `<div class="discord-text-content">${content.replace(/\n/g, '<br>')}</div>`;
    }
    
    let embedsHtml = '';
    if (embeds.length > 0) {
      embedsHtml = `<div class="discord-embeds">` + embeds.map((embed) => {
        const colorVal = Number(embed.color || 0);
        const colorHex = colorVal ? colorVal.toString(16).padStart(6, '0') : '2b2d31';
        
        let titleHtml = '';
        if (embed.title) {
          titleHtml = `<h4 class="discord-embed-title">${escapeHtml(embed.title)}</h4>`;
        }
        
        let descHtml = '';
        if (embed.description) {
          descHtml = `<div class="discord-embed-description">${escapeHtml(embed.description).replace(/\n/g, '<br>')}</div>`;
        }
        
        let fieldsHtml = '';
        if (embed.fields && embed.fields.length > 0) {
          fieldsHtml = `<div class="discord-embed-fields">` + embed.fields.map((field) => `
            <div class="discord-embed-field">
              <div class="discord-embed-field-name">${escapeHtml(field.name)}</div>
              <div class="discord-embed-field-value">${escapeHtml(field.value).replace(/\n/g, '<br>')}</div>
            </div>
          `).join('') + `</div>`;
        }
        
        let footerHtml = '';
        if (embed.footer && embed.footer.text) {
          footerHtml = `<div class="discord-embed-footer">${escapeHtml(embed.footer.text)}</div>`;
        }
        
        return `
          <div class="discord-embed" style="border-left-color: #${colorHex}">
            ${titleHtml}
            ${descHtml}
            ${fieldsHtml}
            ${footerHtml}
          </div>
        `;
      }).join('') + `</div>`;
    }
    
    if (!content && embeds.length === 0) {
      return `<pre class="discord-raw-json">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
    }
    
    return `
      <div class="discord-chat-container">
        <div class="discord-message">
          ${avatarHtml}
          <div class="discord-message-content">
            <div class="discord-author">
              <span class="discord-author-name">${username}</span>
              <span class="discord-bot-badge">BOT</span>
              <span class="discord-timestamp">${timeStr}</span>
            </div>
            ${contentHtml}
            ${embedsHtml}
          </div>
        </div>
      </div>
    `;
  }

  function initLogs() {
    const root = document.querySelector('[data-page="logs"]');
    if (!root) return;
    document.querySelectorAll('[data-log-type]').forEach((button) => button.addEventListener('click', (event) => {
      document.querySelectorAll('[data-log-type]').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
      event.currentTarget.classList.add('active');
      event.currentTarget.setAttribute('aria-pressed', 'true');
      state.logType = button.getAttribute('data-log-type');
      state.seenLogs.clear();
      void loadLogs(false);
    }));
    document.querySelector('[data-log-filter="error"]')?.addEventListener('click', (event) => {
      state.logFilterError = !state.logFilterError;
      event.currentTarget.classList.toggle('active', state.logFilterError);
      event.currentTarget.setAttribute('aria-pressed', String(state.logFilterError));
      state.seenLogs.clear();
      void loadLogs(false);
    });
    document.querySelector('[data-log-pause]')?.addEventListener('click', (event) => {
      state.logsPaused = !state.logsPaused;
      event.currentTarget.textContent = state.logsPaused ? '다시 수신' : '일시정지';
      event.currentTarget.setAttribute('aria-pressed', String(state.logsPaused));
      if (!state.logsPaused) { state.seenLogs.clear(); void loadLogs(false); }
    });
    document.getElementById('load-more-logs')?.addEventListener('click', () => void loadLogs(true));
    void loadLogs(false);
    const stream = document.getElementById('log-stream');
    if (stream && 'EventSource' in window) openLogStream(stream);
  }

  function openLogStream(stream) {
    const endpoint = stream.getAttribute('data-sse');
    if (!endpoint) return;
    const source = new EventSource(endpoint);
    const appendLive = (event) => {
      if (state.logsPaused) return;
      const data = JSON.parse(event.data);
      if (event.type !== state.logType || !shouldShowLog(event.type, data)) return;
      if (state.logsLoading) { state.pendingLogs.push({ type: event.type, data }); return; }
      const key = `${event.type}:${data.id ?? event.lastEventId ?? data.createdAt}`;
      if (state.seenLogs.has(key)) return;
      state.seenLogs.add(key);
      stream.querySelector('[data-empty-logs]')?.remove();
      stream.prepend(logRow(event.type, data));
      // Keep a long-running monitor bounded; older records remain available through pagination.
      while (stream.children.length > 500) stream.lastElementChild.remove();
    };
    source.addEventListener('delivery', appendLive);
    source.addEventListener('fetch', appendLive);
    source.addEventListener('translation', appendLive);
    source.onopen = () => { 
      setStreamStatus(true);
    };
    source.onerror = () => {
      // Native EventSource reconnects with Last-Event-ID, preserving the server cursor.
      setStreamStatus(false);
    };
    window.addEventListener('beforeunload', () => source.close(), { once: true });
  }

  async function loadLogs(append) {
    const version = ++state.logVersion;
    const type = state.logType;
    state.logsLoading = true;
    state.pendingLogs = [];
    const before = append ? state.logBefore[state.logType] : null;
    let result;
    try {
      result = await fetchJson(`/api/logs?type=${type}&limit=50${before ? `&before=${before}` : ''}`);
    } finally {
      if (version === state.logVersion) state.logsLoading = false;
    }
    if (version !== state.logVersion) return;
    state.logBefore[type] = result.nextBefore;
    const stream = document.getElementById('log-stream');
    if (!stream) return;
    if (!append) state.seenLogs.clear();
    const rows = result.items.filter((item) => shouldShowLog(type, item)).flatMap((item) => {
      const key = `${type}:${item.id ?? item.createdAt}`;
      if (state.seenLogs.has(key)) return [];
      state.seenLogs.add(key);
      return [logRow(type, item)];
    });
    if (!append) stream.replaceChildren(...rows);
    else stream.append(...rows);
    for (const { type: liveType, data } of state.pendingLogs) {
      const key = `${liveType}:${data.id ?? data.createdAt}`;
      if (liveType === type && !state.seenLogs.has(key) && shouldShowLog(type, data)) {
        state.seenLogs.add(key);
        stream.prepend(logRow(type, data));
      }
    }
    state.pendingLogs = [];
    if (!stream.children.length) stream.innerHTML = '<div class="empty-inline" data-empty-logs>표시할 로그가 없습니다.</div>';
    const more = document.getElementById('load-more-logs');
    more.disabled = !result.nextBefore;
    more.textContent = result.nextBefore ? '이전 로그 더 보기' : '마지막 로그입니다';
  }

  function setStreamStatus(online) {
    const status = document.querySelector('[data-stream-status]');
    if (status) status.innerHTML = '<span class="tiny-dot ' + (online ? 'green' : 'amber') + '"></span>' + (online ? '실시간 연결됨' : '다시 연결하는 중');
  }

  const LOG_BADGES = { delivery: '전송', fetch: '수집', translation: '번역' };
  const LOG_MESSAGES = {
    delivery: { success: '디스코드 전송 완료', failed: '디스코드 전송 실패' },
    fetch: { ok: '피드 수집 완료', not_modified: '피드 변경 없음', error: '피드 수집 실패' },
    translation: { success: '번역 완료', failed: '번역 실패(원문 사용)', cache_hit: '번역 캐시 사용', skipped: '번역 건너뜀' }
  };

  function logRow(type, item) {
    const row = document.createElement('div');
    row.className = `log-entry log-${type} log-${item.status || ''}`;
    const failed = isFailedLog(item);
    const icon = `<span class="log-indicator ${failed ? 'fail' : 'success'}">${failed ? '✖' : item.status === 'not_modified' ? '↻' : '✔'}</span>`;
    const meta = [];
    if (item.sourceId) meta.push(`소스: <code>${escapeHtml(item.sourceName || item.sourceId)}</code>`);
    if (item.itemId !== null && item.itemId !== undefined) meta.push(`항목 ID: <code>${escapeHtml(item.itemId)}</code>`);
    if (type === 'fetch' && item.status === 'ok') meta.push(`새 항목: <strong>${escapeHtml(item.itemCount ?? 0)}</strong>건`);
    if (item.durationMs !== null && item.durationMs !== undefined) meta.push(`${escapeHtml(item.durationMs)}ms`);
    const detail = item.detail ? ` <span class="${failed ? 'log-error-detail' : 'log-meta'}">${failed ? '오류: ' : ''}${escapeHtml(item.detail)}</span>` : '';
    const label = LOG_MESSAGES[type]?.[item.status] || item.status;
    const messageHtml = `<span class="log-msg ${failed ? 'fail' : 'success'}">${escapeHtml(label)} <span class="log-meta">${meta.join(' | ')}</span>${detail}</span>`;
    const typeBadge = `<span class="log-badge badge-${type}">${LOG_BADGES[type] || type}</span>`;

    row.innerHTML = `
      <span class="log-time">${fmtKst(item.createdAt)}</span>
      ${typeBadge}
      ${icon}
      <span class="log-body-content">${messageHtml}</span>
    `;
    return row;
  }

  function isFailedLog(item) {
    return item.status === 'failed' || item.status === 'error';
  }

  function shouldShowLog(_type, item) {
    return !state.logFilterError || isFailedLog(item);
  }

  function bindGlobalErrors() {
    window.addEventListener('unhandledrejection', (event) => showError(event.reason));
    document.body.addEventListener('htmx:beforeSwap', (event) => {
      const detail = event.detail || {};
      const xhr = detail.xhr;
      if (!xhr) return;
      // htmx 2.x는 204 No Content에 기본적으로 swap하지 않아, 삭제(hx-swap="delete")가 화면에 반영되지 않는다.
      // DELETE 요청의 2xx 응답에는 swap이 일어나게 한다.
      if (detail.requestConfig && detail.requestConfig.verb === 'delete' && xhr.status >= 200 && xhr.status < 300) {
        detail.shouldSwap = true;
        detail.isError = false;
        return;
      }
      if (xhr.status < 400) return;
      detail.shouldSwap = false;
      detail.isError = false;
      renderHtmxError(detail.requestConfig?.elt || detail.elt, xhr);
    });
  }

  function renderHtmxError(trigger, xhr) {
    const contentType = xhr.getResponseHeader?.('content-type') || '';
    const validationFragment = xhr.status >= 400 && xhr.status < 500 && contentType.includes('text/html') && (xhr.responseText || '').trim().startsWith('<');
    if (validationFragment || trigger?.closest?.('dialog[open]')) {
      const host = trigger?.closest?.('form') || trigger?.closest?.('.panel') || document.querySelector('main') || document.body;
      host.querySelectorAll('[data-htmx-inline-error]').forEach((node) => node.remove());
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-htmx-inline-error', 'true');
      wrapper.setAttribute('role', 'alert');
      if (validationFragment) wrapper.innerHTML = xhr.responseText;
      else {
        const message = document.createElement('div');
        message.className = 'form-error';
        message.textContent = errorMessageFromResponse(xhr);
        wrapper.append(message);
      }
      (host.querySelector('.modal-body') || host).prepend(wrapper);
      wrapper.scrollIntoView({ block: 'nearest' });
      return;
    }
    flash(errorMessageFromResponse(xhr));
  }

  function errorMessageFromResponse(xhr) {
    const text = xhr.responseText || xhr.statusText || '요청에 실패했습니다.';
    try {
      const data = JSON.parse(text);
      return data?.error?.message || xhr.statusText || '요청에 실패했습니다.';
    } catch {
      return text.replace(/<[^>]+>/g, '').trim() || xhr.statusText || '요청에 실패했습니다.';
    }
  }

  function updateSystemStatus(online, message = null) {
    const indicator = document.getElementById('system-status-indicator');
    const text = document.getElementById('system-status-text');
    if (!indicator || !text) return;
    
    if (online) {
      indicator.className = 'status-indicator online';
      text.textContent = message || '서버 연결됨';
    } else {
      indicator.className = 'status-indicator offline';
      text.textContent = message || '서버 연결 끊김';
    }
  }

  async function fetchJson(url, options = {}) {
    const init = { method: options.method || 'GET', headers: { accept: 'application/json' } };
    if (options.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      updateSystemStatus(false, '서버 연결 끊김');
      throw error;
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(data?.error?.message || response.statusText);
    updateSystemStatus(true);
    return data;
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => void fn(...args).catch(showError), ms); };
  }

  let flashTimer;
  function flash(message) {
    const target = document.getElementById('flash');
    if (target) {
      clearTimeout(flashTimer);
      target.textContent = message;
      flashTimer = setTimeout(() => { target.textContent = ''; }, 7000);
    }
  }

  function showError(error) {
    flash(error instanceof Error ? error.message : String(error));
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[char] || char));
  }

  function fmtKst(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('ko-KR', { timeZone:'Asia/Seoul', year:'numeric', month:'2-digit',
      day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  }

  function startSystemStatusHeartbeat() {
    const check = () => {
      fetch('/ready', { method: 'GET', headers: { accept: 'application/json' } })
        .then((response) => {
          if (response.ok) {
            updateSystemStatus(true);
          } else {
            updateSystemStatus(false, '서버 연결 끊김');
          }
        })
        .catch(() => {
          updateSystemStatus(false, '서버 연결 끊김');
        });
    };
    check();
    setInterval(check, 30_000);
  }
})();
