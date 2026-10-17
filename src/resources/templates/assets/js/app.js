(() => {
  const state = { logType: 'delivery', logBefore: { delivery: null, fetch: null, translation: null }, logsPaused: false, logFilterError: false, seenLogs: new Set(), logStreamRetryMs: 1000 };

  document.addEventListener('DOMContentLoaded', () => {
    highlightActiveNav();
    applyCurrentSelections();
    initDashboard();
    initTemplateEditor();
    initLogs();
    bindGlobalErrors();
    startSystemStatusHeartbeat();
    initGlobalModalOutsideClick();
    // htmx로 주입된 콘텐츠(예: 소스 추가/수정 모달)에도 저장값 선택 상태를 재적용한다.
    document.body.addEventListener('htmx:afterSwap', (event) => applyCurrentSelections(event.target));
  });

  function initGlobalModalOutsideClick() {
    document.addEventListener('click', (event) => {
      const overlay = event.target.closest('.modal-overlay');
      if (overlay && event.target === overlay) {
        const pageType = overlay.getAttribute('data-page');
        if (pageType === 'source-form') {
          const mount = document.getElementById('source-modal-mount');
          if (mount && mount.contains(overlay)) {
            mount.innerHTML = ''; // 모달로 떠 있으면 마운트만 비워 닫는다(페이지 이동 없음)
          } else {
            window.location.href = '/sources'; // URL 직접 진입(풀페이지)일 때만 목록으로 이동
          }
        } else {
          overlay.style.display = 'none';
          const form = overlay.querySelector('form');
          if (form) form.reset();
        }
      }
    });
  }

  function highlightActiveNav() {
    const path = window.location.pathname;
    let activeId = 'nav-sources'; // default to sources (covers /, /sources, /groups, etc)
    if (path.startsWith('/templates')) activeId = 'nav-templates';
    else if (path.startsWith('/logs')) activeId = 'nav-logs';
    else if (path.startsWith('/model')) activeId = 'nav-model';
    else if (path.startsWith('/delivery-jobs')) activeId = 'nav-delivery-jobs';
    
    document.querySelectorAll('.sidebar-nav .nav-item').forEach((el) => {
      if (el.id === activeId) {
        el.classList.add('active');
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

  function initDashboard() {
    const root = document.querySelector('[data-page="dashboard"]');
    if (!root) return;
    const refresh = async () => {
      const sources = await fetchJson('/api/sources');
      const counts = { sources: sources.length, enabled: sources.filter((s) => s.enabled).length, errors: sources.filter((s) => s.lastOutcome === 'error').length };
      const countRoot = document.getElementById('dashboard-counts');
      if (countRoot) countRoot.innerHTML = `<div><dt>등록된 수집 소스</dt><dd>${counts.sources}</dd></div><div><dt>수집 중인 소스</dt><dd>${counts.enabled}</dd></div><div><dt>오류 발생 소스</dt><dd>${counts.errors}</dd></div>`;
      const table = document.getElementById('dashboard-sources');
      if (table) table.innerHTML = sources.length
        ? sources.map((source) => `<tr data-source-id="${escapeHtml(source.id)}"><td>${escapeHtml(source.name || source.feedUrl)}</td><td><span class="badge ${source.enabled ? 'ok' : 'muted'}">${source.enabled ? '수집 중' : '중지됨'}</span></td><td>${escapeHtml(source.profile)}</td><td>${escapeHtml(source.lastOutcome || '')}</td></tr>`).join('')
        : `<tr><td colspan="4" class="muted" style="text-align:center; padding:2.5rem 1rem;">등록된 수집 소스가 없습니다. <strong>+ 소스 추가</strong>로 첫 피드를 연결하세요.</td></tr>`;
    };
    setInterval(() => void refresh().catch(showError), 30_000);
  }

  function initTemplateEditor() {
    const root = document.querySelector('[data-page="template-editor"]');
    if (!root) return;
    const textarea = document.getElementById('template-body');
    const editor = window.CodeMirror ? window.CodeMirror.fromTextArea(textarea, {
      mode: { name: 'javascript', json: true },
      lineNumbers: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      gutters: ['CodeMirror-lint-markers'],
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
    const mode = document.querySelector('[name="previewMode"]:checked')?.value || 'sample';
    const sourceId = document.getElementById('preview-source')?.value || undefined;
    const templateBody = editor.getValue();
    const target = document.getElementById('preview');
    if (!target) return;
    const result = await fetchJson('/api/preview', { method: 'POST', body: { templateBody, mode, sourceId } });
    if (!result.ok) {
      target.innerHTML = `<div class="form-error">${result.errors.map((e) => `${escapeHtml(e.stage)}: ${escapeHtml(e.message)} ${escapeHtml(e.path || '')}`).join('<br>')}</div>`;
      return;
    }
    target.innerHTML = renderDiscordPayload(result.payload);
  }

  function renderDiscordPayload(payload) {
    const username = escapeHtml(payload.username || 'RSS Monite Bot');
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
      document.querySelectorAll('[data-log-type]').forEach((b) => b.classList.remove('active'));
      event.currentTarget.classList.add('active');
      state.logType = button.getAttribute('data-log-type');
      state.seenLogs.clear();
      void loadLogs(false);
    }));
    document.querySelector('[data-log-filter="error"]')?.addEventListener('click', (event) => {
      state.logFilterError = !state.logFilterError;
      event.currentTarget.classList.toggle('active', state.logFilterError);
      state.seenLogs.clear();
      void loadLogs(false);
    });
    document.querySelector('[data-log-pause]')?.addEventListener('click', (event) => {
      state.logsPaused = !state.logsPaused;
      event.currentTarget.textContent = state.logsPaused ? '▶️ 실시간 스트림 재개' : '⏸️ 실시간 스트림 일시정지';
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
      state.logStreamRetryMs = 1000;
      if (state.logsPaused) return;
      const data = JSON.parse(event.data);
      if (event.type !== state.logType || !shouldShowLog(event.type, data)) return;
      const key = `${event.type}:${data.id ?? event.lastEventId ?? data.createdAt}`;
      if (state.seenLogs.has(key)) return;
      state.seenLogs.add(key);
      stream.prepend(logRow(event.type, data));
    };
    source.addEventListener('delivery', appendLive);
    source.addEventListener('fetch', appendLive);
    source.addEventListener('translation', appendLive);
    source.onopen = () => { 
      state.logStreamRetryMs = 1000; 
      updateSystemStatus(true);
    };
    source.onerror = () => {
      source.close();
      const delay = state.logStreamRetryMs;
      state.logStreamRetryMs = Math.min(delay * 2, 30_000);
      flash(`로그 스트림 연결이 끊겼습니다. ${Math.ceil(delay / 1000)}초 후 다시 연결합니다...`);
      updateSystemStatus(false, '서버 연결 끊김');
      window.setTimeout(() => openLogStream(stream), delay);
    };
    window.addEventListener('beforeunload', () => source.close(), { once: true });
  }

  async function loadLogs(append) {
    const before = append ? state.logBefore[state.logType] : null;
    const result = await fetchJson(`/api/logs?type=${state.logType}&limit=50${before ? `&before=${before}` : ''}`);
    state.logBefore[state.logType] = result.nextBefore;
    const stream = document.getElementById('log-stream');
    if (!stream) return;
    const rows = result.items.filter((item) => shouldShowLog(state.logType, item)).map((item) => {
      state.seenLogs.add(`${state.logType}:${item.id ?? item.createdAt}`);
      return logRow(state.logType, item);
    });
    if (!append) stream.replaceChildren(...rows);
    else stream.append(...rows);
  }

  const LOG_BADGES = { delivery: '✉️ 전송', fetch: '🔄 수집', translation: '🌐 번역' };
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
      renderHtmxError(detail.elt, xhr);
    });
  }

  function renderHtmxError(trigger, xhr) {
    const contentType = xhr.getResponseHeader?.('content-type') || '';
    const validationFragment = xhr.status === 400 && contentType.includes('text/html') && (xhr.responseText || '').trim().startsWith('<');
    if (validationFragment) {
      const host = trigger?.closest?.('form') || trigger?.closest?.('.panel') || document.querySelector('main') || document.body;
      host.querySelectorAll(':scope > [data-htmx-inline-error]').forEach((node) => node.remove());
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-htmx-inline-error', 'true');
      wrapper.innerHTML = xhr.responseText;
      host.prepend(wrapper);
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
      text.textContent = message || '정상 작동 중';
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
    try {
      const response = await fetch(url, init);
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(data?.error?.message || response.statusText);
      updateSystemStatus(true);
      return data;
    } catch (error) {
      updateSystemStatus(false, '서버 연결 끊김');
      throw error;
    }
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => void fn(...args).catch(showError), ms); };
  }

  function flash(message) {
    const target = document.getElementById('flash');
    if (target) target.textContent = message;
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
    setInterval(() => {
      fetch('/api/sources', { method: 'GET', headers: { accept: 'application/json' } })
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
    }, 15_000);
  }
})();
