// Prompt Folders — group Prompt Manager toggles into collapsible, nestable folders.
// Groups are display-only: prompt_order is only changed when you drag an item to a new place.
// Each row shows its real position (#n). Groups are stored per preset name in the extension settings,
// and mirrored into the preset file (extensions.promptFolders) so they travel with a shared preset.

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { oai_settings, promptManager } from '../../../openai.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { escapeHtml, download, getFileText } from '../../../utils.js';
import { getPresetManager } from '../../../preset-manager.js';

const KEY = 'promptFolders';
const CONTAINER_ID = 'completion_prompt_manager';
const LIST_ID = 'completion_prompt_manager_list';
const ROW_SEL = 'li.completion_prompt_manager_prompt[data-pm-identifier]';
const DRAG_CLASS = 'completion_prompt_manager_prompt_draggable';
// 큰 묶음(최상위 그룹)마다 다른 색, 하위 그룹은 큰 묶음 색을 물려받음 — 서로 잘 구별되는 진한 색
const COLORS = ['#7b8cde', '#d9788a', '#4fae94', '#d99a55', '#a47fd1', '#4a9fc9', '#b9a23a', '#c46f5e', '#5f9e6e', '#8c93a3'];

let observer = null;
let applyTimer = null;

const DEFAULTS = { presets: {}, view: 'grouped', showPos: true, wrapNames: true, syncPreset: true, colorStyle: 'dot', layout: 'real', aiMode: 'chat', aiProfile: '', aiModel: '', aiSource: '', aiSourceModel: '', aiCustomUrl: '', aiNoticeOk: false };

// ---------------- 화면 글자 (한국어) ----------------
let KO = {};
async function loadKo() {
    try { KO = await (await fetch(new URL('i18n/ko-kr.json', import.meta.url))).json(); } catch { KO = {}; }
}
/** 영어 원문 키 → 한국어 (사전에 없으면 원문) */
function tr(strings, ...values) {
    const key = strings.reduce((r, s, i) => r + s + (values[i] !== undefined ? `\${${i}}` : ''), '');
    return (KO[key] ?? key).replace(/\$\{(\d+)\}/g, (m, i) => values[i]);
}

function settings() {
    if (!extension_settings[KEY]) extension_settings[KEY] = {};
    const s = extension_settings[KEY];
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = structuredClone(v);
    return s;
}

function presetKey() {
    return oai_settings?.preset_settings_openai || 'Default';
}

function presetData() {
    const s = settings();
    const k = presetKey();
    if (!s.presets[k]) {
        // First time for this preset here: take the groups stored inside the preset file, if any
        const shared = readPresetGroups();
        s.presets[k] = { groups: shared ? structuredClone(shared) : [] };
    }
    return s.presets[k];
}

function readPresetGroups() {
    try {
        const v = getPresetManager('openai')?.readPresetExtensionField({ path: KEY });
        return Array.isArray(v?.groups) ? v.groups : null;
    } catch { return null; }
}

let syncTimer = null;
/** Mirror this preset's groups into the preset file, so sharing the preset shares its groups */
function syncToPreset() {
    if (!settings().syncPreset) return;
    const name = presetKey();
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
        try {
            const groups = settings().presets[name]?.groups;
            if (!groups) return;
            const pm = getPresetManager('openai');
            if (JSON.stringify(pm?.readPresetExtensionField({ name, path: KEY })?.groups ?? null) === JSON.stringify(groups)) return;
            await pm?.writePresetExtensionField({ name, path: KEY, value: { version: 1, groups } });
        } catch (err) {
            console.warn('[Prompt Folders] preset sync failed', err);
        }
    }, 1500);
}

function save() {
    saveSettingsDebounced();
    syncToPreset();
}

function newId() {
    return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function groupColor(g, i, tree) {
    if (g.color) return g.color;
    const fromEmoji = emojiColor(g.name);
    if (fromEmoji) return fromEmoji;
    if (tree) {
        // 이모지가 없는 하위 그룹은 상위 그룹 색, 큰 묶음은 차례대로 팔레트 색
        const parent = tree.parentOf(g);
        if (parent) return groupColor(parent, tree.indexOf(parent), tree);
        return COLORS[tree.topIndexOf(g) % COLORS.length];
    }
    return COLORS[i % COLORS.length];
}

const LEAD_EMOJI = /^\s*((?:\p{Regional_Indicator}{2})|(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*))/u;
// 이모지 색은 한 번 뽑으면 브라우저에 기억 (다음에 열 때 캔버스로 다시 안 그림)
const EMOJI_KEY = 'promptFolders.emojiColors.v1';
const emojiCache = new Map((() => { try { return Object.entries(JSON.parse(localStorage.getItem(EMOJI_KEY) || '{}')); } catch { return []; } })());
let emojiSaveTimer = null;
const saveEmojiCache = () => {
    clearTimeout(emojiSaveTimer);
    emojiSaveTimer = setTimeout(() => { try { localStorage.setItem(EMOJI_KEY, JSON.stringify(Object.fromEntries(emojiCache))); } catch { /* 저장 못 해도 동작엔 지장 없음 */ } }, 1000);
};
/** 이름 맨 앞 이모지를 작은 캔버스에 그려 가장 많은 색을 뽑고, 차분한 톤으로 맞춤 (무채색 이모지는 회색) */
function emojiColor(name) {
    const m = String(name || '').match(LEAD_EMOJI);
    if (!m) return null;
    const emoji = m[1];
    if (emojiCache.has(emoji)) return emojiCache.get(emoji);
    let out = null;
    try {
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.font = '26px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(emoji, 16, 17);
        const px = g.getImageData(0, 0, 32, 32).data;
        // 색상(hue)을 채도로 가중 평균 (원 위의 평균)
        let x = 0, y = 0, w = 0, n = 0;
        for (let k = 0; k < px.length; k += 4) {
            if (px[k + 3] < 140) continue;
            const r = px[k] / 255, gg = px[k + 1] / 255, b = px[k + 2] / 255;
            const max = Math.max(r, gg, b), min = Math.min(r, gg, b), d = max - min;
            n++;
            if (d < 0.12) continue;
            let h = max === r ? ((gg - b) / d) % 6 : max === gg ? (b - r) / d + 2 : (r - gg) / d + 4;
            h = h * Math.PI / 3;
            x += Math.cos(h) * d; y += Math.sin(h) * d; w += d;
        }
        if (n) out = w / n < 0.08 ? '#8c93a3' : hslHex((Math.atan2(y, x) * 180 / Math.PI + 360) % 360, 52, 60);
    } catch { out = null; }
    emojiCache.set(emoji, out);
    saveEmojiCache();
    return out;
}

function hslHex(h, s, l) {
    s /= 100; l /= 100;
    const f = n => {
        const k = (n + h / 30) % 12;
        const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

// ---------------- 렌더링 ----------------

function cleanup(container) {
    container.querySelectorAll('.pf-toolbar, li.pf-group, li.pf-empty, .pf-pos, .pf-tag, .pf-check').forEach(el => el.remove());
    container.querySelectorAll('li.pf-hidden').forEach(el => el.classList.remove('pf-hidden'));
    container.querySelectorAll('li.pf-filtered').forEach(el => el.classList.remove('pf-filtered'));
    container.querySelectorAll('li.pf-selectable').forEach(el => el.classList.remove('pf-selectable'));
}

function apply() {
    // 드래그 중에는 건드리지 않음
    if (document.querySelector(`#${LIST_ID} .ui-sortable-helper`) || drag?.started) {
        scheduleApply();
        return;
    }
    const container = document.getElementById(CONTAINER_ID);
    const list = document.getElementById(LIST_ID);
    if (!container || !list) return;

    // 다시 그리는 동안 목록이 잠깐 짧아져 스크롤이 위로 밀리므로, 감싼 스크롤 칸 위치를 기억했다 되돌림
    const scrolled = [];
    for (let el = container.parentElement; el; el = el.parentElement) if (el.scrollTop) scrolled.push([el, el.scrollTop]);
    pause();
    try {
        cleanup(container);

        const rows = Array.from(list.querySelectorAll(ROW_SEL));
        if (!rows.length) return;

        const pos = new Map();
        const rowById = new Map();
        rows.forEach((row, i) => {
            const id = row.dataset.pmIdentifier;
            pos.set(id, i + 1);
            rowById.set(id, row);
        });
        // 이름은 줄마다 한 번만 찾아 둠 (앞·뒤 이름을 위해 두 번씩 찾던 것)
        const names = rows.map(row => row.querySelector('[data-pm-name]')?.dataset.pmName ?? row.dataset.pmIdentifier);

        document.body.classList.toggle('pf-wrap-names', !!settings().wrapNames);
        ['dot', 'bar', 'none'].forEach(c => document.body.classList.toggle('pf-color-' + c, (settings().colorStyle || 'dot') === c));
        // 모든 항목에 실제 위치 번호
        if (settings().showPos) rows.forEach((row, i) => {
            const nameSpan = row.querySelector('.completion_prompt_manager_prompt_name');
            if (!nameSpan) return;
            const badge = document.createElement('span');
            badge.className = 'pf-pos';
            badge.textContent = '#' + (i + 1);
            const prev = i > 0 ? names[i - 1] : tr`(start)`;
            const next = i + 1 < rows.length ? names[i + 1] : tr`(end)`;
            badge.title = tr`Real position #${i + 1}` + '\n' + tr`Before: ${prev}` + '\n' + tr`After: ${next}`;
            nameSpan.prepend(badge);
        });

        const data = presetData();
        const groups = data.groups;
        const groupOf = new Map();
        groups.forEach((g, gi) => g.members.forEach(id => groupOf.set(id, { g, gi })));

        renderToolbar(list, groups);
        // 그룹 보기: 실리태번 정렬 대신 자유 위치 끌기 / 원래 순서 보기: 실리태번 정렬 그대로
        setSortable(list, settings().view === 'original');
        setupFreeDrag(list);

        if (settings().view === 'original') {
            // 원래 순서 보기: 그룹 이름 태그만 붙임 (그룹 관계 계산은 한 번만)
            const tagTree = makeTree(groups);
            rows.forEach(row => {
                const hit = groupOf.get(row.dataset.pmIdentifier);
                if (hit) addTag(row, hit.g, hit.gi, tagTree);
            });
            return;
        }

        // 그룹 보기 (그룹 안에 그룹 가능)
        const tree = makeTree(groups);
        const ctx = { rowById, pos, tree };
        const topGroups = groups.filter(g => !tree.parentOf(g));
        // 내가 정한 순서: 큰 그룹을 정한 차례대로 목록 맨 위에, 그룹에 안 든 토글은 그 아래 실제 순서대로
        const custom = isCustomLayout();
        const anchor = document.createElement('li');
        anchor.className = 'pf-anchor';
        if (custom) (rows[0] ?? list.firstChild)?.before?.(anchor);
        topGroups.forEach(g => {
            const items = tree.allItems(g).filter(id => rowById.has(id)).sort((a, b) => pos.get(a) - pos.get(b));
            const groupLi = buildGroup(g, ctx, 0);
            if (custom) {
                anchor.before(groupLi);
                items.forEach(id => rowById.get(id).classList.add('pf-hidden'));
            } else if (items.length) {
                rowById.get(items[0]).before(groupLi);
                items.forEach(id => rowById.get(id).classList.add('pf-hidden'));
            } else {
                // 이 프리셋에 남은 항목이 없는 그룹은 목록 맨 위에
                rows[0].before(groupLi);
            }
        });
        anchor.remove();
    } finally {
        for (const [el, top] of scrolled) el.scrollTop = top;
        resume();
    }
}

const isCustomLayout = () => settings().layout === 'custom';

function setSortable(list, enabled) {
    try {
        const $l = window.jQuery?.(list);
        if ($l?.sortable && $l.hasClass('ui-sortable')) $l.sortable(enabled ? 'enable' : 'disable');
    } catch { /* 무시 */ }
}

// ---------------- 그룹 보기 끌기 (자유 위치) ----------------
// 그룹 보기에서는 그룹 안 줄이 복사본이고 원본은 숨겨져 있어서, 실리태번 정렬 기능으로는
// 그룹 사이(그룹이 연달아 있으면 보이는 줄이 없음)나 그룹 안 원하는 순서에 놓을 수가 없었다. 숨긴 원본 위치까지 계산해 렉도 심했다.
// → 그룹 보기에서는 실리태번 정렬을 끄고 화면에 보이는 그대로 끄는 기능을 따로 둔다.
//   줄 위·아래 반쪽: 그 줄 앞·뒤에 놓음(그 줄과 같은 그룹이 됨) / 그룹 머리 위쪽: 그룹 앞(그룹 밖) / 그룹 머리 아래쪽: 그룹 안(펼쳐져 있으면 맨 앞, 접혀 있으면 맨 뒤).
//   놓으면 프롬프트 관리자 순서(prompt_order)를 직접 고쳐 저장하고 다시 그린다. 원래 순서 보기에서는 실리태번 정렬을 그대로 쓴다.
const ROW_VISIBLE = `${ROW_SEL}:not(.pf-hidden), li.pf-clone[data-pf-id]`;
// 이름(누르면 내용 보기)도 잡고 끌 수 있음 — 6px 넘게 움직여야 끌기라서 그냥 누르면 원래대로 내용 보기
const NO_DRAG = '.prompt-manager-toggle-action, .prompt-manager-edit-action, .prompt-manager-detach-action, input, select, textarea, a:not(.prompt-manager-inspect-action), .pf-btn';
let drag = null;          // { id, startX, startY, started, ghost, line, target, pointerId }
let suppressClick = false;

const idOfRow = el => el?.dataset?.pmIdentifier || el?.dataset?.pfId || null;
const directGroupOfRow = el => (el?.classList?.contains('pf-clone') ? el.closest('li.pf-group')?.dataset.pfGroup || null : null);

function setupFreeDrag(list) {
    if (list.dataset.pfFree === '1') return;
    list.dataset.pfFree = '1';
    list.addEventListener('pointerdown', e => {
        if (settings().view === 'original' || e.button !== 0) return;
        // 그룹 머리를 끌면 그룹째 옮김 (마우스) — 터치는 그룹 메뉴의 위로/아래로
        const head = e.target.closest?.('.pf-group-head');
        if (head && list.contains(head)) {
            if (e.pointerType !== 'mouse' || e.target.closest('.pf-btn')) return;
            const gli = head.parentElement;
            drag = { gid: gli.dataset.pfGroup, row: gli, startX: e.clientX, startY: e.clientY, started: false, pointerId: e.pointerId };
            return;
        }
        const row = e.target.closest?.(ROW_VISIBLE);
        if (!row || !list.contains(row) || e.target.closest(NO_DRAG)) return;
        // 터치는 손잡이(☰)로만 — 목록 스크롤과 안 겹치게
        if (e.pointerType !== 'mouse' && !e.target.closest('.drag-handle')) return;
        drag = { id: idOfRow(row), row, startX: e.clientX, startY: e.clientY, started: false, pointerId: e.pointerId };
    });
    // 이름(링크)을 잡고 끌 때 브라우저의 링크 끌기가 끼어들지 않게
    list.addEventListener('dragstart', e => { if (drag && settings().view !== 'original') e.preventDefault(); });
    list.addEventListener('click', e => {
        if (!suppressClick) return;
        suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
    }, true);
    if (!window.__pfFreeDocHooked) {
        window.__pfFreeDocHooked = true;
        document.addEventListener('pointermove', onDragMove, { passive: false });
        document.addEventListener('pointerup', onDragEnd);
        document.addEventListener('pointercancel', () => endDrag(false));
    }
}

function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.started) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
        drag.started = true;
        document.body.classList.add('pf-dragging');
        const ghost = document.createElement('div');
        ghost.className = 'pf-ghost';
        ghost.textContent = drag.gid
            ? '📁 ' + (drag.row.querySelector(':scope > .pf-group-head .pf-name')?.textContent || '')
            : drag.row.querySelector('[data-pm-name]')?.dataset.pmName || drag.id;
        const line = document.createElement('div');
        line.className = 'pf-drop-line';
        document.body.append(ghost, line);
        drag.ghost = ghost;
        drag.line = line;
        drag.row.classList.add('pf-drag-source');
        // 목록 맨 끝(그룹 밖)에 놓는 칸 — 맨 끝이 그룹이어도 그 그룹 밖 마지막에 넣을 수 있게
        const end = document.createElement('li');
        end.className = 'pf-end-zone';
        end.textContent = tr`Drop here for the very end (outside groups)`;
        document.getElementById(LIST_ID)?.append(end);
        drag.end = end;
    }
    e.preventDefault();
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.ghost.style.left = (e.clientX + 12) + 'px';
    drag.ghost.style.top = (e.clientY + 8) + 'px';
    updateDropTarget();
    if (!drag.raf) drag.raf = requestAnimationFrame(dragAutoScroll);
}

function updateDropTarget() {
    const list = document.getElementById(LIST_ID);
    let target = null;
    for (const el of document.elementsFromPoint(drag.x, drag.y)) {
        if (!list?.contains(el)) continue;
        if (drag.gid && drag.row.contains(el)) continue;   // 그룹을 자기 안에는 못 놓음
        if (el.closest('.pf-end-zone')) { target = { type: 'end' }; break; }
        const head = el.closest('.pf-group-head');
        if (head) {
            const r = head.getBoundingClientRect();
            target = { type: 'head', gid: head.parentElement.dataset.pfGroup, zone: drag.y < r.top + r.height * 0.35 ? 'before' : 'into', rect: r };
            break;
        }
        const row = el.closest(ROW_VISIBLE);
        if (row) {
            const r = row.getBoundingClientRect();
            target = { type: 'row', el: row, before: drag.y < r.top + r.height / 2, rect: r };
            break;
        }
    }
    // 목록 아래 빈 곳도 맨 끝으로
    if (!target && drag.end) {
        const er = drag.end.getBoundingClientRect();
        if (drag.y > er.top && drag.x >= er.left && drag.x <= er.right) target = { type: 'end' };
    }
    drag.end?.classList.toggle('pf-end-active', target?.type === 'end');
    drag.target = target;
    markDropTarget(target?.type === 'head' && target.zone === 'into' ? target.gid : null);
    const line = drag.line;
    if (!target || target.type === 'end' || (target.type === 'head' && target.zone === 'into') || (target.type === 'row' && idOfRow(target.el) === drag.id)) {
        line.style.display = 'none';
        return;
    }
    const r = target.rect;
    const y = target.type === 'head' ? r.top : (target.before ? r.top : r.bottom);
    line.style.display = 'block';
    line.style.left = r.left + 'px';
    line.style.width = r.width + 'px';
    line.style.top = (y - 1) + 'px';
}

function dragAutoScroll() {
    if (!drag?.started) return;
    drag.raf = null;
    const list = document.getElementById(LIST_ID);
    if (!list) return;
    const sc = scrollParent(list);
    const r = sc.getBoundingClientRect();
    const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, window.innerHeight);
    const EDGE = 48;
    let dy = 0;
    if (drag.y > bottom - EDGE) dy = Math.ceil((drag.y - (bottom - EDGE)) / 3) + 4;
    else if (drag.y < top + EDGE) dy = -(Math.ceil(((top + EDGE) - drag.y) / 3) + 4);
    if (dy) {
        sc.scrollTop += dy;
        updateDropTarget();
        drag.raf = requestAnimationFrame(dragAutoScroll);
    }
}

function markDropTarget(id) {
    document.querySelectorAll('.pf-group-head.pf-drop-target').forEach(el => el.classList.remove('pf-drop-target'));
    if (id) document.querySelector(`li.pf-group[data-pf-group="${CSS.escape(id)}"] > .pf-group-head`)?.classList.add('pf-drop-target');
}

function onDragEnd(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    endDrag(drag.started);
}

function endDrag(commit) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    d.ghost?.remove();
    d.line?.remove();
    d.end?.remove();
    d.row?.classList.remove('pf-drag-source');
    document.body.classList.remove('pf-dragging');
    markDropTarget(null);
    if (!d.started) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (commit && d.target) d.gid ? dropGroup(d.gid, d.target) : dropAt(d.id, d.target);
}

/** 놓은 자리를 (기준 항목, 앞/뒤, 들어갈 그룹)으로 바꿔 순서·소속을 저장 */
function dropAt(id, target) {
    const data = presetData();
    const tree = makeTree(data.groups);
    const pm = promptManager;
    if (!pm?.activeCharacter) return;
    const order = pm.getPromptOrderForCharacter(pm.activeCharacter).slice();
    const at = new Map(order.map((e, i) => [e.identifier, i]));
    const byOrder = ids => ids.filter(x => at.has(x) && x !== id).sort((a, b) => at.get(a) - at.get(b));

    let refId = null, before = true, groupId = null;
    if (target.type === 'end') {
        const rest = order.filter(e => e.identifier !== id);
        refId = rest[rest.length - 1]?.identifier ?? null;
        before = false;
        groupId = null;
    } else if (target.type === 'row') {
        refId = idOfRow(target.el);
        before = target.before;
        groupId = directGroupOfRow(target.el);
        if (refId === id) return;
    } else {
        const g = tree.byId.get(target.gid);
        if (!g) return;
        const items = byOrder(tree.allItems(g));
        if (target.zone === 'before') {
            refId = items[0] ?? null;
            before = true;
            groupId = tree.parentOf(g)?.id ?? null;
        } else {
            groupId = g.id;
            if (g.collapsed) { refId = items[items.length - 1] ?? null; before = false; }
            else { refId = items[0] ?? null; before = true; }
        }
    }

    // 소속: 한 항목은 한 그룹에만
    data.groups.forEach(g => { g.members = g.members.filter(m => m !== id); });
    if (groupId) {
        const g = tree.byId.get(groupId);
        if (g) {
            g.members.push(id);
            for (let p = g; p; p = tree.parentOf(p)) p.collapsed = false;
        }
    }
    save();

    // 순서
    try {
        const from = order.findIndex(e => e.identifier === id);
        if (from >= 0 && refId && refId !== id) {
            const [entry] = order.splice(from, 1);
            let to = order.findIndex(e => e.identifier === refId);
            if (to < 0) order.splice(from, 0, entry);
            else order.splice(before ? to : to + 1, 0, entry);
            pm.removePromptOrderForCharacter(pm.activeCharacter);
            pm.addPromptOrderForCharacter(pm.activeCharacter, order);
            pm.saveServiceSettings();
        }
        pm.render();
    } catch (err) {
        console.warn('[Prompt Folders] move failed', err);
        scheduleApply();
    }
}

/** 그룹을 놓은 자리 → (기준 항목, 앞/뒤, 새 상위 그룹) 으로 바꿔 그룹째 옮김 */
function dropGroup(gid, target) {
    const data = presetData();
    const tree = makeTree(data.groups);
    const g = tree.byId.get(gid);
    if (!g) return;
    if (isCustomLayout()) return dropGroupView(g, target, data, tree);
    const mine = new Set(tree.allItems(g));
    const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter) || [];
    const at = new Map(order.map((e, i) => [e.identifier, i]));
    const byOrder = ids => ids.filter(x => at.has(x) && !mine.has(x)).sort((a, b) => at.get(a) - at.get(b));
    let refId = null, before = true, parentId = null;
    if (target.type === 'end') {
        const rest = order.filter(e => !mine.has(e.identifier));
        refId = rest[rest.length - 1]?.identifier ?? null;
        before = false;
    } else if (target.type === 'row') {
        refId = idOfRow(target.el);
        before = target.before;
        parentId = directGroupOfRow(target.el);
    } else {
        const t = tree.byId.get(target.gid);
        if (!t || t === g || tree.isDescendant(t, g)) return;
        const items = byOrder(tree.allItems(t));
        if (target.zone === 'before') {
            refId = items[0] ?? null;
            parentId = tree.parentOf(t)?.id ?? null;
        } else {
            parentId = t.id;
            if (t.collapsed) { refId = items[items.length - 1] ?? null; before = false; } else { refId = items[0] ?? null; }
        }
    }
    return moveGroup(g, refId, before, parentId);
}

/** 그룹 안 토글 전체를 한 덩어리로 기준 항목 앞/뒤에 옮김 (떨어져 있던 토글은 한곳에 모임 — 먼저 물어봄) */
async function moveGroup(g, refId, before, parentId) {
    const pm = promptManager;
    if (!pm?.activeCharacter) return;
    const data = presetData();
    const tree = makeTree(data.groups);
    const parent = parentId ? tree.byId.get(parentId) : null;
    if (parent && (parent === g || tree.isDescendant(parent, g))) return;
    const mine = new Set(tree.allItems(g));
    if (refId && mine.has(refId)) return;
    const order = pm.getPromptOrderForCharacter(pm.activeCharacter).slice();
    const idx = order.map((e, i) => (mine.has(e.identifier) ? i : -1)).filter(i => i >= 0);
    if (idx.length) {
        const between = idx[idx.length - 1] - idx[0] + 1 - idx.length;
        if (between > 0) {
            const ok = await callGenericPopup(escapeHtml(tr`The toggles of "${g.name}" are spread out (#${idx[0] + 1}~#${idx[idx.length - 1] + 1}, with ${between} other toggles between them). Moving the group gathers them in one place, which changes the real prompt order. Continue?`), POPUP_TYPE.CONFIRM);
            if (!ok) return;
        }
        const block = order.filter(e => mine.has(e.identifier));
        const rest = order.filter(e => !mine.has(e.identifier));
        let to = refId ? rest.findIndex(e => e.identifier === refId) : -1;
        to = to < 0 ? rest.length : (before ? to : to + 1);
        rest.splice(to, 0, ...block);
        pm.removePromptOrderForCharacter(pm.activeCharacter);
        pm.addPromptOrderForCharacter(pm.activeCharacter, rest);
        pm.saveServiceSettings();
    }
    g.parent = parent ? parent.id : null;
    if (parent) parent.collapsed = false;
    save();
    pm.render();
    scheduleApply();
}

/** 그룹 메뉴의 위로/아래로: 화면에서 바로 위·아래에 보이는 항목(토글이나 그룹)과 자리를 바꿈 */
/** 내가 정한 순서: 그룹 목록(배열) 순서·상위만 바꿈 — 실제 프롬프트 순서는 그대로 */
function placeInArray(g, beforeGroup, parentId) {
    const data = presetData();
    data.groups = data.groups.filter(x => x !== g);
    g.parent = parentId || null;
    const i = beforeGroup ? data.groups.indexOf(beforeGroup) : -1;
    if (i >= 0) data.groups.splice(i, 0, g); else data.groups.push(g);
    if (parentId) { const p = data.groups.find(x => x.id === parentId); if (p) p.collapsed = false; }
    save();
    apply();
}

function dropGroupView(g, target, data, tree) {
    if (target.type === 'head') {
        const t = tree.byId.get(target.gid);
        if (!t || t === g || tree.isDescendant(t, g)) return;
        if (target.zone === 'before') return placeInArray(g, t, tree.parentOf(t)?.id ?? null);
        return placeInArray(g, null, t.id);
    }
    if (target.type === 'row') {
        const pid = directGroupOfRow(target.el);
        const p = pid ? tree.byId.get(pid) : null;
        if (p && (p === g || tree.isDescendant(p, g))) return;
        return placeInArray(g, null, pid);
    }
    return placeInArray(g, null, null);
}

function stepGroup(g, dir) {
    if (isCustomLayout()) {
        const tree = makeTree(presetData().groups);
        const sibs = presetData().groups.filter(x => tree.parentOf(x) === tree.parentOf(g));
        const i = sibs.indexOf(g), j = i + dir;
        if (j < 0 || j >= sibs.length) return void toastr.info(dir < 0 ? tr`Already at the top.` : tr`Already at the bottom.`, tr`Prompt Folders`);
        const data = presetData();
        const a = data.groups.indexOf(g), b = data.groups.indexOf(sibs[j]);
        [data.groups[a], data.groups[b]] = [data.groups[b], data.groups[a]];
        save();
        apply();
        return;
    }
    const li = document.querySelector(`#${LIST_ID} li.pf-group[data-pf-group="${CSS.escape(g.id)}"]`);
    if (!li) return;
    const visible = el => el && (el.matches('li.pf-group, li.pf-clone') || (el.matches(ROW_SEL) && !el.classList.contains('pf-hidden') && !el.classList.contains('pf-filtered')));
    let sib = dir < 0 ? li.previousElementSibling : li.nextElementSibling;
    while (sib && !visible(sib)) sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling;
    if (!sib) return void toastr.info(dir < 0 ? tr`Already at the top.` : tr`Already at the bottom.`, tr`Prompt Folders`);
    const tree = makeTree(presetData().groups);
    const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter) || [];
    const at = new Map(order.map((e, i) => [e.identifier, i]));
    let ids;
    if (sib.matches('li.pf-group')) {
        const t = tree.byId.get(sib.dataset.pfGroup);
        ids = (t ? tree.allItems(t) : []).filter(x => at.has(x)).sort((a, b) => at.get(a) - at.get(b));
    } else {
        ids = [idOfRow(sib)];
    }
    if (!ids.length) return;
    moveGroup(g, dir < 0 ? ids[0] : ids[ids.length - 1], dir < 0, tree.parentOf(g)?.id ?? null);
}

function scrollParent(el) {
    for (let p = el?.parentElement; p; p = p.parentElement) {
        const oy = getComputedStyle(p).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    }
    return document.scrollingElement;
}

function addTag(row, g, gi, tree = makeTree(presetData().groups)) {
    const tag = document.createElement('span');
    tag.className = 'pf-tag';
    tag.style.setProperty('--pf-color', groupColor(g, gi, tree));
    tag.textContent = tree.path(g).map(x => x.name).join(' › ');
    row.querySelector('.completion_prompt_manager_prompt_name')?.append(tag);
}

function renderToolbar(list, groups) {
    const bar = document.createElement('div');
    bar.className = 'pf-toolbar';
    bar.setAttribute('role', 'toolbar');
    const e = escapeHtml;
    const ib = (cls, icon, label, extra = '') => `<div class="pf-ib ${cls}" role="button" tabindex="0" title="${e(label)}" aria-label="${e(label)}" ${extra}><i class="fa-solid ${icon}"></i></div>`;

    {
        const view = settings().view;
        const anyOpen = presetData().groups.some(g => !g.collapsed);
        bar.innerHTML = `
            ${ib('pf-new', 'fa-folder-plus', tr`New group`)}
            ${groups.length ? '' : ib('pf-auto', 'fa-wand-magic-sparkles', tr`Auto-group`)}
            ${groups.length ? ib('pf-view', 'fa-list-ol', tr`Show in real order`, `aria-pressed="${view === 'original'}"`) : ''}
            ${groups.length && view !== 'original' ? ib('pf-fold', anyOpen ? 'fa-angles-up' : 'fa-angles-down', anyOpen ? tr`Collapse all` : tr`Expand all`) : ''}
            ${ib('pf-tools', 'fa-ellipsis', tr`Import / export groups`)}`;
        bar.querySelector('.pf-new').addEventListener('click', () => createGroup(null));
        bar.querySelector('.pf-auto')?.addEventListener('click', autoGroup);
        bar.querySelector('.pf-tools').addEventListener('click', ev => openToolsMenu(ev.currentTarget));
        bar.querySelector('.pf-view')?.addEventListener('click', () => {
            settings().view = view === 'original' ? 'grouped' : 'original';
            save();
            apply();
        });
        bar.querySelector('.pf-fold')?.addEventListener('click', () => setAllCollapsed(anyOpen));
    }
    // 키보드: Enter/Space 로 누르기
    bar.querySelectorAll('[role="button"]').forEach(el => el.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); el.click(); }
    }));
    list.before(bar);
}

/** 그룹 관계(상위/하위)를 다루는 도우미 */
function makeTree(groups) {
    const byId = new Map(groups.map(g => [g.id, g]));
    const parentOf = g => {
        const p = g.parent ? byId.get(g.parent) : null;
        return p && p !== g ? p : null;
    };
    const childrenOf = g => groups.filter(x => parentOf(x) === g);
    const isDescendant = (g, maybeAncestor) => {
        for (let p = parentOf(g), n = 0; p && n < 50; p = parentOf(p), n++) if (p === maybeAncestor) return true;
        return false;
    };
    const allItems = (g, seen = new Set()) => {
        if (seen.has(g)) return [];
        seen.add(g);
        return [...g.members, ...childrenOf(g).flatMap(c => allItems(c, seen))];
    };
    const path = g => {
        const out = [g];
        for (let p = parentOf(g), n = 0; p && n < 50; p = parentOf(p), n++) out.unshift(p);
        return out;
    };
    const indexOf = g => groups.indexOf(g);
    const tops = groups.filter(x => !parentOf(x));
    const topIndexOf = g => tops.indexOf(g);
    return { byId, parentOf, childrenOf, isDescendant, allItems, path, indexOf, topIndexOf };
}

function buildGroup(g, ctx, depth) {
    const { rowById, pos, tree } = ctx;
    const gi = tree.indexOf(g);
    const items = tree.allItems(g).filter(id => rowById.has(id)).sort((a, b) => pos.get(a) - pos.get(b));
    // 검색 중에는 맞는 항목이 있는 그룹만, 펼쳐서
    const open = !g.collapsed;

    const li = document.createElement('li');
    li.className = 'pf-group' + (open ? '' : ' pf-collapsed') + (depth ? ' pf-sub' : '');
    li.dataset.pfGroup = g.id;
    li.style.setProperty('--pf-color', groupColor(g, gi, tree));

    const isOff = id => rowById.get(id).classList.contains('completion_prompt_manager_prompt_disabled');
    const enabledCount = items.filter(id => !isOff(id)).length;
    const tokens = items.reduce((sum, id) => {
        if (isOff(id)) return sum;
        const t = Number(rowById.get(id).querySelector('.prompt_manager_prompt_tokens')?.dataset.pmTokens);
        return sum + (Number.isFinite(t) ? t : 0);
    }, 0);
    const range = items.length ? `#${pos.get(items[0])}${items.length > 1 ? '~#' + pos.get(items[items.length - 1]) : ''}` : tr`no items`;
    const allOn = items.length > 0 && enabledCount === items.length;
    const exclusive = !!g.exclusive;
    const subCount = tree.childrenOf(g).length;

    const head = document.createElement('div');
    head.className = 'pf-group-head';
    head.title = [g.name, tr`On ${enabledCount}/${items.length} · real position ${range}`,
        subCount ? tr`${subCount} sub-groups` : '', tokens ? tr`Tokens of enabled items: ${tokens}` : ''].filter(Boolean).join('\n');
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(open));
    head.tabIndex = 0;
    head.innerHTML = `
        <span class="pf-caret fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'}"></span>
        ${subCount ? '<span class="pf-folder fa-solid fa-folder-tree"></span>' : ''}
        <span class="pf-name">${escapeHtml(g.name)}</span>
        ${exclusive ? `<span class="pf-one" title="${escapeHtml(tr`Only one toggle in this group can be on`)}">${escapeHtml(tr`Pick 1`)}</span>` : ''}
        <span class="pf-count">${enabledCount}/${items.length}</span>
        ${exclusive
        ? `<span class="pf-btn pf-toggle-all fa-solid ${enabledCount ? 'fa-toggle-on' : 'fa-toggle-off pf-btn-idle'}" role="button" title="${escapeHtml(enabledCount ? tr`Turn the whole group off` : tr`Turn one toggle on from inside the group`)}"></span>`
        : `<span class="pf-btn pf-toggle-all fa-solid ${allOn ? 'fa-toggle-on' : 'fa-toggle-off'}" role="button" title="${escapeHtml(allOn ? tr`Turn the whole group off` : tr`Turn the whole group on`)}"></span>`}
        <span class="pf-btn pf-more fa-solid fa-ellipsis-vertical" role="button" title="${escapeHtml(tr`Group menu`)}"></span>`;
    li.append(head);

    const toggleOpen = () => {
        g.collapsed = !g.collapsed;
        save();
        apply();
    };
    head.addEventListener('click', e => { if (!e.target.closest('.pf-btn')) toggleOpen(); });
    head.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === head) { e.preventDefault(); toggleOpen(); } });
    head.querySelector('.pf-toggle-all').addEventListener('click', () => {
        if (exclusive) { if (enabledCount) toggleAll(items, false); return; }
        toggleAll(items, !allOn);
    });
    head.querySelector('.pf-more').addEventListener('click', e => openGroupMenu(g, e.currentTarget, range));

    const body = document.createElement('ul');
    body.className = 'pf-group-body';
    {
        // 직접 넣은 항목과 하위 그룹을 실제 위치 순서대로 (접힌 그룹도 그려 두고 CSS 로 숨김 — 검색이 다시 그리지 않고 펼칠 수 있게)
        const entries = [];
        g.members.filter(id => rowById.has(id)).forEach(id => entries.push({ at: pos.get(id), el: () => cloneRow(rowById.get(id)) }));
        tree.childrenOf(g).forEach((c, ci0) => {
            const ci = tree.allItems(c).filter(id => rowById.has(id)).map(id => pos.get(id));
            const at = isCustomLayout() ? -100000 + ci0 : (ci.length ? Math.min(...ci) : Infinity);
            entries.push({ at, el: () => buildGroup(c, ctx, depth + 1) });
        });
        entries.sort((a, b) => a.at - b.at).forEach(x => body.append(x.el()));
    }
    li.append(body);
    return li;
}

// ---------------- 그룹 메뉴 (⋮) ----------------

let menuAnchor = null;

function closeGroupMenu() {
    document.querySelectorAll('.pf-menu').forEach(m => m.remove());
    document.removeEventListener('pointerdown', onMenuOutside, true);
    menuAnchor = null;
}

function onMenuOutside(e) {
    if (e.target.closest('.pf-menu')) return;
    // 메뉴를 연 단추를 다시 누른 경우는 그 단추의 클릭에서 닫음 (여기서 닫으면 클릭이 다시 엶)
    if (menuAnchor?.contains(e.target)) return;
    closeGroupMenu();
}

/** 같은 단추로 연 메뉴가 열려 있으면 닫고 true */
function toggleSameMenu(anchor) {
    const open = menuAnchor === anchor && document.querySelector('.pf-menu');
    closeGroupMenu();
    return !!open;
}

function openGroupMenu(g, anchor, range) {
    if (toggleSameMenu(anchor)) return;
    const menu = document.createElement('div');
    menu.className = 'pf-menu';
    // ST는 패널 밖을 누르면 열린 패널(프롬프트 창)을 닫는다. 메뉴를 누른 건 패널 밖 클릭으로 치지 않게 막음
    ['mousedown', 'touchstart'].forEach(type => menu.addEventListener(type, e => e.stopPropagation()));
    const item = (icon, label, fn, cls = '') => {
        const b = document.createElement('div');
        b.className = 'pf-menu-item ' + cls;
        b.innerHTML = `<i class="fa-solid ${icon}"></i><span>${label}</span>`;
        b.addEventListener('click', () => { closeGroupMenu(); fn(); });
        menu.append(b);
    };
    const info = document.createElement('div');
    info.className = 'pf-menu-info';
    info.textContent = tr`Real position ${range}`;
    menu.append(info);
    item('fa-pen-to-square', escapeHtml(tr`Edit group`), () => startEditing(g));
    item('fa-folder-plus', escapeHtml(tr`New group inside`), () => createGroup(g.id));
    item('fa-palette', escapeHtml(tr`Change color`), () => pickColor(g, anchor));
    item(g.exclusive ? 'fa-toggle-on' : 'fa-toggle-off', escapeHtml(tr`Only one on at a time`), () => setExclusive(g, !g.exclusive));
    item('fa-arrow-up', escapeHtml(tr`Move group up`), () => stepGroup(g, -1));
    item('fa-arrow-down', escapeHtml(tr`Move group down`), () => stepGroup(g, 1));
    const sep2 = document.createElement('div');
    sep2.className = 'pf-menu-sep';
    menu.append(sep2);
    item('fa-trash-can', escapeHtml(tr`Ungroup`), () => deleteGroup(g), 'pf-menu-danger');
    placeMenu(menu, anchor);
}

function placeMenu(menu, anchor) {
    document.body.append(menu);
    menuAnchor = anchor;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const x = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw));
    const y = r.bottom + 4 + mh <= window.innerHeight - 8 ? r.bottom + 4 : Math.max(8, r.top - mh - 4);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    setTimeout(() => document.addEventListener('pointerdown', onMenuOutside, true), 0);
}

/** Small menu for the toolbar's ⋯ button: export / import */
function openToolsMenu(anchor) {
    if (toggleSameMenu(anchor)) return;
    const menu = document.createElement('div');
    menu.className = 'pf-menu';
    ['mousedown', 'touchstart'].forEach(type => menu.addEventListener(type, e => e.stopPropagation()));
    const item = (icon, label, fn) => {
        const b = document.createElement('div');
        b.className = 'pf-menu-item';
        b.innerHTML = `<i class="fa-solid ${icon}"></i><span>${escapeHtml(label)}</span>`;
        b.addEventListener('click', () => { closeGroupMenu(); fn(); });
        menu.append(b);
    };
    const info = document.createElement('div');
    info.className = 'pf-menu-info';
    info.textContent = presetKey();
    menu.append(info);
    item('fa-wand-magic-sparkles', tr`Auto-group`, autoGroup);
    const sepL = document.createElement('div');
    sepL.className = 'pf-menu-sep';
    sepL.textContent = tr`Group placement`;
    menu.append(sepL);
    for (const [val, label] of [['real', tr`By real prompt order`], ['custom', tr`My own order (view only)`]]) {
        item((settings().layout || 'real') === val ? 'fa-check' : 'fa-blank', label, () => { settings().layout = val; saveSettingsDebounced(); apply(); });
    }
    const sepC = document.createElement('div');
    sepC.className = 'pf-menu-sep';
    sepC.textContent = tr`Group colors`;
    menu.append(sepC);
    for (const [val, label] of [['dot', tr`Dot`], ['bar', tr`Color bar`], ['none', tr`None`]]) {
        item((settings().colorStyle || 'dot') === val ? 'fa-check' : 'fa-blank', label, () => { settings().colorStyle = val; saveSettingsDebounced(); apply(); });
    }
    const sepE = document.createElement('div');
    sepE.className = 'pf-menu-sep';
    menu.append(sepE);
    item('fa-file-export', tr`Export groups`, exportGroups);
    item('fa-file-import', tr`Import groups`, importGroups);
    if (presetData().groups.length) {
        const sepU = document.createElement('div');
        sepU.className = 'pf-menu-sep';
        menu.append(sepU);
        item('fa-folder-minus', tr`Ungroup all`, ungroupAll);
        menu.lastElementChild.classList.add('pf-menu-danger');
    }
    placeMenu(menu, anchor);
}

// ---------------- 자동 그룹 (특정 프리셋 글자 없이, 일반 규칙만) ----------------
// 장식 = 비ASCII 기호·이모지 (━ ═ ★ 🔹 같은 것. | [ ] : - 같은 보통 기호와 문장부호는 장식이 아님)
// 1) 구분선: 장식만 있는 이름 / 같은 장식 3번 이상 연속 / 내용이 비어 있고 장식이 있는 토글 / 글자가 같고 장식이 있는 내용 없는 짝
// 2) 비슷한 이름: 붙어 있는 토글 3개 이상이 낱말 단위로 같은 앞부분을 가지면 한 묶음
// 3) 단계: 장식이 눈에 띄게 많은 구분선이 큰 구역, 적은 구분선은 그 안의 하위 구역. 글자가 같은 두 번째 구분선은 그 구역을 닫음
const ST_MARKERS = new Set(['main', 'nsfw', 'jailbreak', 'chatHistory', 'worldInfoBefore', 'worldInfoAfter', 'dialogueExamples', 'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'enhanceDefinitions']);
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = s => (segmenter ? Array.from(segmenter.segment(s), x => x.segment) : Array.from(s));
const isWordG = g => /[\p{Lu}\p{Ll}\p{Lt}\p{Lo}\p{N}]/u.test(g);   // ﾟ 같은 수식 기호(Lm)는 글자가 아님
const isDecoG = g => /\p{Extended_Pictographic}/u.test(g) || (/\p{S}/u.test(g) && /[^\x00-\x7F]/.test(g));
const lettersOnly = s => String(s || '').replace(/\{\{[^}]*\}\}/g, '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
const contentLen = p => String(p?.content || '').replace(/\{\{\/\/[\s\S]*?\}\}/g, '').trim().length;

function decoShape(name) {
    const gs = graphemes(String(name || '').trim());
    const deco = gs.filter(isDecoG);
    let run = 0, maxRun = 0;
    for (let i = 0; i < gs.length; i++) {
        run = isDecoG(gs[i]) && gs[i] === gs[i - 1] ? run + 1 : 1;
        if (isDecoG(gs[i])) maxRun = Math.max(maxRun, run);
    }
    return { words: gs.filter(isWordG).length, deco: deco.length, maxRun };
}

/** 구분선 id → 장식 양 */
function findHeaders(order, getPrompt) {
    const headers = new Map();
    const candidates = order.map(e => e.identifier).filter(id => getPrompt(id) && !ST_MARKERS.has(id));
    for (const id of candidates) {
        const p = getPrompt(id);
        const s = decoShape(p.name);
        if ((s.words === 0 && s.deco >= 2) || s.maxRun >= 3 || (contentLen(p) === 0 && s.deco >= 1)) headers.set(id, s.deco);
    }
    // 글자가 같은 이름 둘(시작·끝 짝)이 둘 다 내용이 거의 없으면 구분선
    const byText = new Map();
    candidates.forEach(id => {
        const t = lettersOnly(getPrompt(id).name);
        if (t) byText.set(t, [...(byText.get(t) || []), id]);
    });
    byText.forEach(ids => {
        if (ids.length === 2 && ids.some(id => decoShape(getPrompt(id).name).deco > 0) && ids.every(id => headers.has(id) || contentLen(getPrompt(id)) < 40)) ids.forEach(id => headers.set(id, Math.max(1, decoShape(getPrompt(id).name).deco)));
    });
    // 같은 이모지로 시작하는 내용 없는 항목이 3개 넘게 이어지면(🚫 Never · 🚫 Gonna …) 구분선이 아니라 한 묶음
    for (let i = 0; i < candidates.length;) {
        const lead = graphemes(String(getPrompt(candidates[i]).name || '').trim())[0];
        let j = i;
        const weak = id => { const sh = decoShape(getPrompt(id).name); return sh.words > 0 && sh.maxRun < 3 && contentLen(getPrompt(id)) === 0; };
        while (j < candidates.length && headers.has(candidates[j]) && weak(candidates[j]) && graphemes(String(getPrompt(candidates[j]).name || '').trim())[0] === lead) j++;
        if (j - i >= 3) candidates.slice(i, j).forEach(id => headers.delete(id));
        i = Math.max(j, i + 1);
    }
    // 이름 없는 빈 토글 = 구분선
    headers.blank = new Set();
    candidates.forEach(id => {
        const p = getPrompt(id);
        if (contentLen(p) === 0 && !graphemes(String(p.name || '')).some(g => isWordG(g) || isDecoG(g))) { headers.set(id, 0); headers.blank.add(id); }
    });
    // 시작 · 끝 짝: ⤵ … ⤴, <tag> … </tag>, start/시작 … end/끝 — 짝이 맞는 것만
    headers.pairs = new Map(); headers.depth = new Map();
    const stack = [];
    const bare = n => String(n || '').replace(/[\u2934\u2935\uFE0F]/gu, '').trim();
    const pairKey = n => lettersOnly(bare(n).replace(/\b(?:start|begin|end)\b|시작|종료|끝|开始|结束|開始|終了/gi, ''));
    // 실리태번 기본 자리를 이름만 바꿔 끝 표시로 쓰는 프리셋도 있어서 짝은 목록 전체에서 찾음
    for (const id of order.map(e => e.identifier).filter(id => getPrompt(id))) {
        const n = String(getPrompt(id).name || ''), b = bare(n);
        const close = /\u2934/u.test(n) || /^<\/[A-Za-z][\w-]*\s*>$/.test(b) || /\bend\b|종료|끝|结束|終了/i.test(b);
        const open = !close && (/\u2935/u.test(n) || /^<[A-Za-z][\w-]*\b[^>]*>$/.test(b) || /\b(?:start|begin)\b|시작|开始|開始/i.test(b));
        if (open) { headers.depth.set(id, stack.length); stack.push(id); continue; }
        if (!close || !stack.length) continue;
        let k = stack.length - 1;
        while (k >= 0 && pairKey(getPrompt(stack[k]).name) !== pairKey(n)) k--;
        if (k < 0 && /\u2934/u.test(n) && /\u2935/u.test(getPrompt(stack[stack.length - 1]).name)) k = stack.length - 1;
        if (k < 0) continue;
        headers.pairs.set(id, stack[k]);
        stack.splice(k);
    }
    // 깊이는 짝이 맞은 구역끼리만 셈 (끝이 없는 「시작」은 무시)
    const pos = new Map(order.map((e, i) => [e.identifier, i]));
    const spans = [...headers.pairs].map(([c, o]) => [pos.get(o), pos.get(c), o]);
    headers.depth.clear();
    spans.forEach(([a, b, o]) => headers.depth.set(o, spans.filter(([x, y]) => x < a && y > b).length));
    headers.depth.forEach((_, id) => headers.set(id, Math.max(headers.get(id) ?? 0, 1)));
    headers.pairs.forEach((_, id) => headers.set(id, Math.max(headers.get(id) ?? 0, 1)));
    return headers;
}

/** 구분선 이름 → 그룹 이름: 앞뒤 장식·기호를 떼되 글자 바로 앞 이모지 하나는 남김. 글자가 없으면 '' */
function headerTitle(name) {
    const gs = graphemes(String(name || '').replace(/\s+/g, ' ').trim());
    let a = 0, b = gs.length;
    while (a < b && !isWordG(gs[a]) && !/[([（【「{]/.test(gs[a])) a++;
    while (b > a && !isWordG(gs[b - 1]) && !/[)\]）】」}]/.test(gs[b - 1])) b--;
    if (a >= b || !gs.slice(a, b).some(isWordG)) return '';
    let i = a - 1;
    while (i >= 0 && gs[i] === ' ') i--;
    const lead = i >= 0 && /\p{Extended_Pictographic}/u.test(gs[i]) && gs[i] !== gs[i - 1] ? gs[i] + ' ' : '';
    return balanced((lead + gs.slice(a, b).join('')).trim());
}

/** 괄호 짝이 맞지 않으면 짝 없는 괄호부터 잘라냄 (strict: 짝이 안 맞으면 '') */
function balanced(t, strict = false) {
    const open = '([{（【「', close = ')]}）】」';
    const stack = [];
    const gs = graphemes(t);
    for (let i = 0; i < gs.length; i++) {
        if (open.includes(gs[i])) stack.push(i);
        else if (close.includes(gs[i])) { if (stack.length) stack.pop(); else return strict ? '' : gs.slice(0, i).join('').trim(); }
    }
    if (strict && stack.length) return '';
    return (stack.length ? gs.slice(0, stack[0]) : gs).join('').replace(/[\s:：|\-–—·,_/]+$/u, '').trim();
}

/** 낱말 단위 공통 앞부분: 두 이름 모두 그 뒤가 낱말 경계(공백·기호·끝)일 때만 */
function commonPrefix(a, b) {
    const x = graphemes(a), y = graphemes(b);
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    while (i > 0 && ((i < x.length && isWordG(x[i]) && isWordG(x[i - 1])) || (i < y.length && isWordG(y[i]) && isWordG(y[i - 1])))) i--;
    return x.slice(0, i).join('');
}
const runName = p => { const t = balanced(p.replace(/\{\{[^}]*$/u, '').trim(), true); return t && balanced(t.replace(/^[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E\s]+/u, '').trim()); };
const strongName = n => graphemes(n).filter(isWordG).length >= 3;
const usefulName = n => graphemes(n).filter(isWordG).length >= 2 || (graphemes(n).length <= 2 && graphemes(n).some(g => /\p{Extended_Pictographic}/u.test(g)));

/** 낱말 단위 공통 끝부분 */
function commonSuffix(names) {
    const rev = n => graphemes(n).reverse();
    const xs = names.map(rev);
    let i = 0;
    while (xs.every(x => i < x.length && x[i] === xs[0][i])) i++;
    while (i > 0 && xs.some(x => i < x.length && isWordG(x[i]) && isWordG(x[i - 1]))) i--;
    return xs[0].slice(0, i).reverse().join('').trim();
}

/** 이모지만 남은 묶음 이름: 이름들의 공통 끝부분(감싼 괄호 벗김)을 붙임 */
function betterRunName(name, members, nameOf) {
    if (graphemes(name).some(isWordG)) return name;
    let tail = commonSuffix(members.map(nameOf));
    const m = tail.match(/^[([{（【「](.*)[)\]}）】」]$/u);
    if (m) tail = m[1].trim();
    tail = balanced(tail, true);
    return tail && graphemes(tail).filter(isWordG).length >= 2 ? `${name} ${tail}` : name;
}

/** 이름 모양: 앞 장식·이모지를 떼고 「이름표:」 의 이름표 (예: '⛓️ 선택: 강압' → '선택'). 이름표가 없으면 '' */
function labelKey(name) {
    const gs = graphemes(String(name || '').trim());
    let a = 0;
    while (a < gs.length && !isWordG(gs[a])) a++;
    const m = gs.slice(a).join('').match(/^([^:：]{1,20}?)\s*[:：]\s*\S/u);
    return m && graphemes(m[1]).some(isWordG) ? m[1].trim() : '';
}

/** 이름 앞부분이 같은 연속 묶음(3개 이상) · 앞 이모지만 다르고 이름표가 같은 연속 묶음(2개 이상) */
function nameRuns(ids, nameOf, minInSection = 0) {
    const runs = [];
    let i = 0;
    while (i < ids.length) {
        if (ST_MARKERS.has(ids[i])) { i++; continue; }
        let pre = nameOf(ids[i]), j = i + 1;
        for (; j < ids.length; j++) {
            if (ST_MARKERS.has(ids[j])) break;
            const next = commonPrefix(pre, nameOf(ids[j]));
            if (!usefulName(runName(next))) break;
            // 뚜렷한 머리말(낱말 2개 이상)로 2개 이상 묶였는데 이모지만 남게 되면 거기서 끊음
            if (j - i >= 2 && strongName(runName(pre)) && !graphemes(runName(next)).some(isWordG)) break;
            pre = next;
        }
        const name = runName(pre);
        const need = minInSection || (strongName(name) ? 2 : 3);
        if (j - i >= need && usefulName(name)) { runs.push({ name: betterRunName(name, ids.slice(i, j), nameOf), members: ids.slice(i, j) }); i = j; continue; }
        const key = labelKey(nameOf(ids[i]));
        let k = i + 1;
        while (key && k < ids.length && !ST_MARKERS.has(ids[k]) && labelKey(nameOf(ids[k])) === key) k++;
        if (k - i >= Math.max(2, minInSection)) { runs.push({ name: key, members: ids.slice(i, k) }); i = k; continue; }
        // 끝말이 같은 연속 묶음(3개 이상): {{char}}'s PoV · Everyone's PoV · Shift PoV → PoV
        const tailOf = names => runName(commonSuffix(names));
        let t = i + 1;
        while (t < ids.length && !ST_MARKERS.has(ids[t]) && graphemes(tailOf(ids.slice(i, t + 1).map(nameOf))).filter(isWordG).length >= 3) t++;
        if (t - i >= Math.max(3, minInSection)) { runs.push({ name: tailOf(ids.slice(i, t).map(nameOf)), members: ids.slice(i, t) }); i = t; } else i++;
    }
    return runs;
}

/** 묶음 계획: [{ name, members, children: [{ name, members }] }] — name 이 '' 이면 이름 없음 */
function planAutoGroups(order, getPrompt) {
    const headers = findHeaders(order, getPrompt);
    // 이름 비교에선 {{char}} 같은 매크로를 뺌
    const nameOf = id => String(getPrompt(id)?.name ?? id).replace(/\{\{[^}]*\}\}/g, ' ').replace(/\s+/g, ' ').trim();
    // 장식 양이 두 무리로 뚜렷이 갈리면 두 단계 (큰 구역이 2개 이상이고 작은 구역보다 적을 때)
    const vals = [...headers].filter(([id]) => !headers.blank.has(id) && !headers.depth.has(id) && !headers.pairs.has(id)).map(([, v]) => v).sort((a, b) => a - b);
    let cut = Infinity;
    if (vals.length >= 4) {
        let best = 0;
        for (let k = 1; k < vals.length; k++) if (vals[k] - vals[k - 1] > best) { best = vals[k] - vals[k - 1]; cut = vals[k]; }
        const big = vals.filter(v => v >= cut).length;
        if (best < 2 || big < 2 || big >= vals.length - big) cut = Infinity;
    }
    // 짝 구역: 바깥 짝은 큰 구역, 안쪽 짝 · 짝 구역 안의 다른 구분선은 하위 구역
    const isBig = id => headers.depth.has(id) ? headers.depth.get(id) === 0 : !top?.pair && (headers.blank.has(id) || cut === Infinity || headers.get(id) >= cut);

    let top = null, sub = null, loose = [];
    const sections = [];
    const flushLoose = () => { if (loose.length) sections.push({ loose }); loose = []; };
    const sameText = (a, b) => { const t = lettersOnly(nameOf(a)); return !!t && t === lettersOnly(nameOf(b)); };
    for (const e of order) {
        const id = e.identifier;
        if (!headers.has(id)) {
            if (sub ?? top) (sub ?? top).members.push(id); else loose.push(id);
            continue;
        }
        if (headers.pairs.has(id)) {
            const opener = headers.pairs.get(id);
            if (sub?.header === opener) { sub.members.push(id); sub = null; continue; }
            if (top?.header === opener) { top.members.push(id); top = sub = null; continue; }
            if (sub ?? top) (sub ?? top).members.push(id); else loose.push(id);
            continue;
        }
        if (sub && sameText(id, sub.header)) { sub.members.push(id); sub = null; continue; }
        if (top && sameText(id, top.header)) { top.members.push(id); top = sub = null; continue; }
        if (isBig(id) || !top) {
            flushLoose();
            top = { header: id, members: [id], children: [], pair: headers.depth.has(id) };
            sections.push(top);
            sub = null;
        } else {
            sub = { header: id, members: [id] };
            top.children.push(sub);
        }
    }
    flushLoose();

    // 이름 없는 구역(빈 구분선)은 안의 토글 이름으로: 절반 넘게 덮는 묶음 이름 → 공통 끝말 → 없음
    const real = ids => ids.filter(id => !headers.blank.has(id));
    const titleOf = (header, ids) => {
        const raw = headers.depth.has(header) ? nameOf(header).replace(/\b(?:start|begin)\b|시작|开始|開始/gi, ' ') : nameOf(header);
        const t = headers.blank.has(header) ? '' : headerTitle(raw);
        if (t) return t;
        const body = real(ids.filter(id => id !== header));
        const run = nameRuns(body, nameOf, 2).find(r => r.members.length * 2 > body.length);
        if (run) return run.name;
        const tail = runName(commonSuffix(body.map(nameOf)));
        return graphemes(tail).filter(isWordG).length >= 3 ? tail : '';
    };
    const out = [];
    for (const s of sections) {
        if (s.loose) {
            nameRuns(s.loose, nameOf).forEach(r => out.push({ name: r.name, members: r.members, children: [] }));
            continue;
        }
        const children = s.children.filter(c => real(c.members).length > 1).map(c => ({ name: titleOf(c.header, c.members), members: c.members }));
        s.children.filter(c => real(c.members).length <= 1).forEach(c => s.members.push(...c.members));
        // 구분선 하나가 목록 대부분(절반 넘게)을 덮으면 큰 그룹은 쓸모가 없음 → 그 안의 묶음을 맨 위 그룹으로
        const size = s.members.length + children.reduce((n, c) => n + c.members.length, 0);
        if (order.length >= 20 && size > order.length * 0.5) {
            const body = s.members.filter(id => id !== s.header);
            const inner = children.length ? children : [];
            const used = new Set(inner.flatMap(c => c.members));
            nameRuns(body.filter(id => !used.has(id)), nameOf).forEach(r => inner.push(r));
            inner.sort((a, b) => order.findIndex(e => e.identifier === a.members[0]) - order.findIndex(e => e.identifier === b.members[0]));
            inner.forEach(c => out.push({ name: c.name, members: c.members, children: [] }));
            continue;
        }
        if (!children.length) {
            const body = s.members.filter(id => id !== s.header);
            const lead = graphemes(headerTitle(nameOf(s.header)))[0] ?? '';
            nameRuns(body, nameOf, 3)
                .filter(r => r.members.length < body.length)
                // 구역 이름과 같은 이모지만 있는 묶음은 구역과 같은 말이라 하위 그룹으로 안 만듦
                .filter(r => graphemes(r.name).some(isWordG) || graphemes(r.name)[0] !== lead)
                .forEach(r => children.push({ name: r.name, members: r.members }));
        }
        const inChildren = new Set(children.flatMap(c => c.members));
        const direct = s.members.filter(id => !inChildren.has(id));
        if (real(direct).length + real([...inChildren]).length < 2) continue;
        out.push({ name: titleOf(s.header, s.members), members: direct, children });
    }
    // 이름이 겹치면 뒤 그룹은 토글 앞 이모지(3가지 이하)를 붙이거나 번호를 붙임
    const seen = new Map();
    for (const n of out.flatMap(g => [g, ...g.children])) {
        if (!n.name) continue;
        const count = (seen.get(n.name) || 0) + 1;
        seen.set(n.name, count);
        if (count === 1) continue;
        const leads = [...new Set(n.members.map(id => graphemes(nameOf(id))[0]).filter(g => /\p{Extended_Pictographic}|\p{RI}/u.test(g)))];
        n.name = leads.length && leads.length <= 3 ? `${leads.join('')} ${n.name}` : `${n.name} ${count}`;
    }
    return out;
}

// AI 로 묶기: 토글 이름 · 내용 앞부분을 지금 연결된 API 로 한 번 보내 그룹 계획을 받음 (번호로 주고받아 이름이 바뀌어도 안전)
const AI_GROUP_PROMPT = `You organise the prompt toggles of a SillyTavern preset into folders so a user can find them quickly.
Input: one line per toggle — index | on/off | name. Only names are given, not the prompt text. Names may be decorated with symbols; markers like ⤵/⤴, start/end, <tag>/</tag> or blank names often open and close sections.
Return ONLY JSON: {"groups":[{"name":"","items":[0,1],"children":[{"name":"","items":[2,3]}]}]}
- Follow the preset's own sections when it has them; otherwise group by purpose (language, POV, style, pacing, NSFW, trackers, reasoning, jailbreak/system, etc.).
- Put "pick one" alternatives together. Keep a section's opening and closing marker in that section's group.
- Prefer neighbouring toggles; each index at most once; toggles that fit nowhere can stay out.
- 4 to 14 top-level groups. children are optional sub-folders (at least 2 items each).
- name: short Korean (2–12 characters) starting with one fitting emoji, e.g. "🌐 언어", "🎬 문체".`;

/** 실리태번 연결 프로필 목록 (Connection Manager) */
const aiProfiles = () => SillyTavern.getContext().extensionSettings.connectionManager?.profiles || [];
/** 공급자 직접: 번역기와 같은 8개. 키는 실리태번 서버에 저장된 것을 서버가 붙임 */
const PROVIDERS = [
    ['openai', 'OpenAI'], ['custom', 'Custom (OpenAI-compatible)'], ['claude', 'Claude'], ['cohere', 'Cohere'],
    ['makersuite', 'Google AI'], ['vertexai', 'Google Vertex AI'], ['openrouter', 'OpenRouter'], ['deepseek', 'DeepSeek'],
];
const providerName = id => { const p = PROVIDERS.find(x => x[0] === id); return p ? tr([p[1]]) : (document.querySelector(`#chat_completion_source option[value="${id}"]`)?.textContent.trim() || id); };
// 실리태번이 공급자마다 기억하는 모델 (API 설정에서 고른 것)
const MODEL_KEY = { openai: 'openai_model', custom: 'custom_model', claude: 'claude_model', cohere: 'cohere_model', makersuite: 'google_model', vertexai: 'vertexai_model', openrouter: 'openrouter_model', deepseek: 'deepseek_model' };
// 목록을 주지 않는 공급자(Claude · Vertex)와 목록을 못 받았을 때 보여 줄 이름
const KNOWN_MODELS = {
    claude: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    vertexai: ['gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    makersuite: ['gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    openai: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6', 'gpt-5.5', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
    deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
};
const LISTABLE = new Set(['openai', 'custom', 'cohere', 'makersuite', 'openrouter', 'deepseek']);
const modelCache = new Map();   // 공급자(+주소) → { ids, at } — 이 창에서 한 번 받으면 하루 동안
const fetching = new Set();
const failedAt = new Map();   // 목록을 못 받은 공급자 — 10분 동안은 저절로 다시 묻지 않음 (↻ 는 바로)
const cacheKeyOf = source => source === 'custom' ? `custom@${customUrlOf()}` : source;
const customUrlOf = () => String(settings().aiCustomUrl || SillyTavern.getContext().chatCompletionSettings?.custom_url || '').trim();
function loadCache(key) {
    if (modelCache.has(key)) return modelCache.get(key);
    try { const v = JSON.parse(localStorage.getItem(`pf-ai-models:${key}`) || 'null'); if (v?.ids && Date.now() - v.at < 864e5) { modelCache.set(key, v); return v; } } catch { /* 없음 */ }
    return null;
}
/** 실리태번 서버에 그 공급자의 모델 목록을 물음 (/status — 키는 서버가 붙임) */
async function fetchModels(source) {
    const key = cacheKeyOf(source);
    if (!LISTABLE.has(source) || fetching.has(key)) return;
    failedAt.delete(key);
    fetching.add(key); fillAiPickers(document);
    try {
        const c = SillyTavern.getContext(), o = c.chatCompletionSettings || {};
        const body = { chat_completion_source: source };
        if (source === 'custom') Object.assign(body, { custom_url: customUrlOf(), custom_include_headers: o.custom_include_headers });
        if (o.reverse_proxy && source === o.chat_completion_source) Object.assign(body, { reverse_proxy: o.reverse_proxy, proxy_password: o.proxy_password });
        const res = await fetch('/api/backends/chat-completions/status', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.data?.data) ? data.data.data : Array.isArray(data?.models) ? data.models : [];
        const ids = [...new Set(rows.map(m => String(m?.id ?? m?.name ?? '').replace(/^models\//, '')).filter(Boolean))].sort();
        if (ids.length) { const v = { ids, at: Date.now() }; modelCache.set(key, v); try { localStorage.setItem(`pf-ai-models:${key}`, JSON.stringify(v)); } catch { /* 저장 못 해도 됨 */ } }
        else failedAt.set(key, Date.now());
    } catch (err) {
        failedAt.set(key, Date.now());
        console.warn('[Prompt Folders] model list', err);
    } finally { fetching.delete(key); fillAiPickers(document); }
}
/** 고를 수 있는 모델: 받은 목록 → 없으면 알려진 이름 + 실리태번 API 화면 목록. current = API 설정에서 고른 모델 */
function aiModelsOf(source) {
    const o = SillyTavern.getContext().chatCompletionSettings || {};
    const current = String(o[MODEL_KEY[source]] || '').trim();
    const got = loadCache(cacheKeyOf(source));
    if (!got && LISTABLE.has(source) && !(Date.now() - (failedAt.get(cacheKeyOf(source)) || 0) < 6e5)) fetchModels(source);
    const sel = document.getElementById(`model_${source === 'makersuite' ? 'google' : source}_select`);
    const page = sel ? [...sel.options].map(x => x.value).filter(v => v && !/^(custom|OR_Website)$/.test(v)) : [];
    const list = got?.ids?.length ? got.ids : [...(KNOWN_MODELS[source] || []), ...page];
    return { list: [...new Set(list)], current, loading: fetching.has(cacheKeyOf(source)) };
}

/** AI 요청 — 연결 방식: 지금 채팅 연결 / 연결 프로필(+모델) / 공급자 직접(+모델). 그룹 나누기는 깊이 생각할 일이 아니라 생각 수준은 낮게 */
async function aiCall(system, prompt, signal) {
    const c = SillyTavern.getContext(), s = settings();
    const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
    const o = c.chatCompletionSettings || {};
    if (s.aiMode === 'profile') {
        const profile = aiProfiles().find(p => p.id === s.aiProfile);
        if (!profile) throw new Error(tr`Pick a connection profile.`);
        if (!c.ConnectionManagerRequestService) throw new Error(tr`Turn on SillyTavern's Connection Manager extension.`);
        const payload = { custom_prompt_post_processing: 'merge', reasoning_effort: 'low' };
        if (String(s.aiModel || '').trim()) payload.model = String(s.aiModel).trim();
        if (profile.api === 'vertexai') Object.assign(payload, { vertexai_auth_mode: o.vertexai_auth_mode || 'express', ...(o.vertexai_express_project_id ? { vertexai_express_project_id: o.vertexai_express_project_id } : {}) });
        const res = await c.ConnectionManagerRequestService.sendRequest(profile.id, messages, 8192, { stream: false, signal, extractData: true, includePreset: true }, payload);
        return String(res?.content ?? res ?? '');
    }
    let source = o.chat_completion_source, model = c.getChatCompletionModel?.();
    if (s.aiMode === 'provider') {
        source = s.aiSource || source;
        model = String(s.aiSourceModel || '').trim() || aiModelsOf(source).current;
        if (!model) throw new Error(tr`Pick a model.`);
        if (source === 'custom' && !customUrlOf()) throw new Error(tr`Enter the server address.`);
    } else if (c.mainApi !== 'openai' || !source) {
        return String(await c.generateRaw({ systemPrompt: system, prompt, responseLength: 8192 }) || '');
    }
    const body = { chat_completion_source: source, model, messages, stream: false, temperature: 0.3, max_tokens: 8192, reasoning_effort: 'low' };
    if (source === 'vertexai') Object.assign(body, { vertexai_auth_mode: o.vertexai_auth_mode || 'full', vertexai_region: o.vertexai_region || 'us-central1', vertexai_express_project_id: o.vertexai_express_project_id || '' });
    if (source === 'custom') Object.assign(body, { custom_url: s.aiMode === 'provider' ? customUrlOf() : o.custom_url, custom_include_headers: o.custom_include_headers, custom_include_body: o.custom_include_body, custom_exclude_body: o.custom_exclude_body });
    // 프록시는 채팅에 쓰는 공급자와 같을 때만 (다른 공급자에 엉뚱한 프록시가 붙지 않게)
    if (o.reverse_proxy && source === o.chat_completion_source) Object.assign(body, { reverse_proxy: o.reverse_proxy, proxy_password: o.proxy_password });
    const res = await fetch('/api/backends/chat-completions/generate', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify(body), signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error?.message || `${res.status}`);
    return String(data.choices?.[0]?.message?.content ?? (data.candidates?.[0]?.content?.parts || []).filter(x => !x.thought).map(x => x.text || '').join(''));
}

/** 지금 고른 연결을 사람이 읽는 글로 */
function aiTargetLabel() {
    const s = settings(), c = SillyTavern.getContext();
    const srcName = providerName;
    if (s.aiMode === 'profile') {
        const p = aiProfiles().find(x => x.id === s.aiProfile);
        return tr`Connection profile "${p?.name || '?'}"` + (s.aiModel ? ` · ${s.aiModel}` : '');
    }
    if (s.aiMode === 'provider') return `${srcName(s.aiSource)} · ${s.aiSourceModel || aiModelsOf(s.aiSource).current}`;
    const cur = c.chatCompletionSettings?.chat_completion_source;
    return tr`Current chat connection` + (c.mainApi === 'openai' && cur ? ` (${srcName(cur)} · ${c.getChatCompletionModel?.() || ''})` : '');
}

/** 처음 쓸 때 무엇을 어디로 보내는지 알림 — 「다시 묻지 않기」 전까지 매번 */
async function confirmAiSend(count) {
    if (settings().aiNoticeOk) return true;
    const e = escapeHtml, root = document.createElement('div');
    root.className = 'pf-ai-notice';
    root.innerHTML = `
        <h3>${e(tr`Before grouping with AI`)}</h3>
        <ul>
            <li><b>${e(tr`Sent`)}</b> — ${e(tr`the names of ${count} toggles, with their order and on/off state.`)}</li>
            <li><b>${e(tr`Not sent`)}</b> — ${e(tr`the prompt text inside the toggles, your chat, or anything else.`)}</li>
            <li><b>${e(tr`Sent to`)}</b> — ${e(aiTargetLabel())}. ${e(tr`Nothing goes to the extension author or any other server.`)}</li>
        </ul>
        <label class="checkbox_label"><input type="checkbox" class="pf-ai-notice-ok"><span>${e(tr`Don't ask again`)}</span></label>`;
    const ok = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: tr`Send`, cancelButton: tr`Cancel` });
    if (ok && root.querySelector('.pf-ai-notice-ok').checked) { settings().aiNoticeOk = true; saveSettingsDebounced(); }
    return !!ok;
}

// 연결 고르기 칸 (설정 화면 · 미리보기 창 공용): 방식 알약 3개 + 고른 방식의 칸만
const aiPickersHtml = () => {
    const e = escapeHtml;
    return `<div class="pf-ai-conn">
        <div class="pf-ai-modes" role="radiogroup" aria-label="${e(tr`Connection for AI grouping`)}">
            <button type="button" role="radio" data-mode="chat">${e(tr`Current chat connection`)}</button>
            <button type="button" role="radio" data-mode="profile">${e(tr`Connection profile`)}</button>
            <button type="button" role="radio" data-mode="provider">${e(tr`Provider`)}</button>
        </div>
        <div class="pf-ai-fields" data-for="chat"><small class="pf-ai-now"></small></div>
        <div class="pf-ai-fields" data-for="profile">
            <label><span>${e(tr`Profile`)}</span><select class="text_pole pf-ai-profile"></select></label>
            <label><span>${e(tr`Model`)}</span><select class="text_pole pf-ai-pick-model" data-key="aiModel"></select><input class="text_pole pf-ai-custom" data-key="aiModel" type="text" placeholder="${e(tr`Model name`)}" hidden></label>
        </div>
        <div class="pf-ai-fields" data-for="provider">
            <label><span>${e(tr`Service`)}</span><select class="text_pole pf-ai-source"></select></label>
            <label class="pf-ai-url-row"><span>${e(tr`Server address`)}</span><input class="text_pole pf-ai-url" type="text" placeholder="https://…/v1"></label>
            <label><span>${e(tr`Model`)} <button type="button" class="pf-ai-reload" title="${e(tr`Reload model list`)}" aria-label="${e(tr`Reload model list`)}"><i class="fa-solid fa-rotate-right"></i></button></span><select class="text_pole pf-ai-pick-model" data-key="aiSourceModel"></select><input class="text_pole pf-ai-custom" data-key="aiSourceModel" type="text" placeholder="${e(tr`Model name`)}" hidden></label>
        </div>
    </div>`;
};
/** 모델 칸: 기본값 · 목록에서 고르기 · 「직접 입력…」(고르면 입력칸이 나옴) */
const CUSTOM = '__custom__';
function fillModel(host, key, list, defaultLabel, noDefault = false) {
    const e = escapeHtml, value = String(settings()[key] || ''), sel = host.querySelector('.pf-ai-pick-model'), inp = host.querySelector('.pf-ai-custom');
    const custom = !!value && !list.includes(value);
    const typing = custom || sel.dataset.typing === '1';
    sel.innerHTML = `<option value=""${noDefault ? ' disabled' : ''}>${e(defaultLabel)}</option>` + list.map(m => `<option value="${e(m)}">${e(m)}</option>`).join('') + `<option value="${CUSTOM}">${e(tr`Type a model name…`)}</option>`;
    sel.value = typing ? CUSTOM : value;
    inp.hidden = !typing;
    if (document.activeElement !== inp) inp.value = custom ? value : '';
}

function fillAiPickers(root) {
    const s = settings(), c = SillyTavern.getContext(), e = escapeHtml;
    const current = c.chatCompletionSettings?.chat_completion_source;
    const nameOfSource = providerName;
    root.querySelectorAll('.pf-ai-conn').forEach(box => {
        box.querySelectorAll('.pf-ai-modes button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === s.aiMode)));
        box.querySelectorAll('.pf-ai-fields').forEach(f => { f.hidden = f.dataset.for !== s.aiMode; });
        box.querySelector('.pf-ai-now').textContent = c.mainApi === 'openai' && current ? tr`Now: ${nameOfSource(current)} · ${c.getChatCompletionModel?.() || ''}` : tr`Uses the API you chat with now.`;
        const ps = box.querySelector('.pf-ai-profile'), profiles = aiProfiles();
        ps.innerHTML = profiles.length ? profiles.map(p => `<option value="${e(p.id)}">${e(p.name || p.id)}</option>`).join('') : `<option value="">${e(tr`No connection profiles`)}</option>`;
        if (!profiles.some(p => p.id === s.aiProfile)) s.aiProfile = profiles[0]?.id || '';
        ps.value = s.aiProfile;
        const prof = profiles.find(p => p.id === s.aiProfile);
        fillModel(box.querySelector('[data-for="profile"]'), 'aiModel', prof?.api ? aiModelsOf(prof.api).list : [], prof?.model ? tr`Profile model (${prof.model})` : tr`Profile model`);
        const ss = box.querySelector('.pf-ai-source');
        ss.innerHTML = PROVIDERS.map(([id]) => `<option value="${e(id)}">${e(providerName(id))}</option>`).join('');
        if (!PROVIDERS.some(x => x[0] === s.aiSource)) s.aiSource = PROVIDERS.some(x => x[0] === current) ? current : 'openai';
        ss.value = s.aiSource;
        const urlRow = box.querySelector('.pf-ai-url-row'), url = box.querySelector('.pf-ai-url');
        urlRow.hidden = s.aiSource !== 'custom';
        if (document.activeElement !== url) url.value = customUrlOf();
        const models = aiModelsOf(s.aiSource), prov = box.querySelector('[data-for="provider"]');
        const first = models.loading ? tr`Loading the model list…` : models.current ? tr`Selected in API settings (${models.current})` : tr`Pick a model`;
        fillModel(prov, 'aiSourceModel', models.list, first, !models.current);
        prov.querySelector('.pf-ai-reload').hidden = !LISTABLE.has(s.aiSource);
        prov.querySelector('.pf-ai-reload').classList.toggle('pf-spin', models.loading);
    });
}
function bindAiPickers(root) {
    const set = (k, v) => { settings()[k] = v; saveSettingsDebounced(); fillAiPickers(document); };
    root.querySelectorAll('.pf-ai-conn').forEach(box => {
        box.querySelectorAll('.pf-ai-modes button').forEach(b => b.addEventListener('click', () => set('aiMode', b.dataset.mode)));
        box.querySelector('.pf-ai-profile').addEventListener('change', ev => { settings().aiModel = ''; box.querySelector('[data-for="profile"] .pf-ai-pick-model').dataset.typing = ''; set('aiProfile', ev.target.value); });
        box.querySelectorAll('.pf-ai-pick-model').forEach(sel => sel.addEventListener('change', () => {
            const typing = sel.value === CUSTOM;
            sel.dataset.typing = typing ? '1' : '';
            set(sel.dataset.key, typing ? '' : sel.value);
            if (typing) sel.parentElement.querySelector('.pf-ai-custom').focus();
        }));
        box.querySelectorAll('.pf-ai-custom').forEach(inp => inp.addEventListener('change', () => set(inp.dataset.key, inp.value.trim())));
        box.querySelector('.pf-ai-url').addEventListener('change', ev => set('aiCustomUrl', ev.target.value.trim()));
        box.querySelector('.pf-ai-reload').addEventListener('click', ev => { ev.preventDefault(); const k = cacheKeyOf(settings().aiSource); modelCache.delete(k); try { localStorage.removeItem(`pf-ai-models:${k}`); } catch { /* 없음 */ } fetchModels(settings().aiSource); });
        box.querySelector('.pf-ai-source').addEventListener('change', ev => { settings().aiSourceModel = ''; box.querySelector('[data-for="provider"] .pf-ai-pick-model').dataset.typing = ''; set('aiSource', ev.target.value); });
    });
    fillAiPickers(root);
}

async function aiPlan(order, getPrompt, signal) {
    const c = SillyTavern.getContext();
    const ids = order.map(x => x.identifier).filter(id => getPrompt(id));
    const lines = ids.map((id, i) => {
        const p = getPrompt(id), on = order.find(x => x.identifier === id)?.enabled;
        // 프롬프트 내용은 보내지 않음 (제작자 글 보호) — 이름만
        return `${i} | ${on ? 'on' : 'off'} | ${String(p.name || '').trim() || '(no name)'}`;
    });
    const raw = await aiCall(AI_GROUP_PROMPT, lines.join('\n'), signal);
    let rows;
    try { rows = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).groups; } catch { throw new Error(tr`Couldn't read the AI answer. Try again.`); }
    const used = new Set();
    const take = items => (Array.isArray(items) ? items : []).map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < ids.length && !used.has(i) && used.add(i)).map(i => ids[i]);
    const plan = [];
    for (const g of Array.isArray(rows) ? rows : []) {
        const children = (Array.isArray(g?.children) ? g.children : []).map(k => ({ name: String(k?.name || '').trim().slice(0, 40), members: take(k?.items) })).filter(k => k.members.length >= 2);
        const members = take(g?.items);
        if (members.length + children.reduce((n, k) => n + k.members.length, 0) < 2) continue;
        plan.push({ name: String(g?.name || '').trim().slice(0, 40), members, children });
    }
    const at = new Map(ids.map((id, i) => [id, i]));
    const first = n => Math.min(...[...n.members, ...n.children.flatMap(k => k.members)].map(id => at.get(id)));
    return plan.sort((a, b) => first(a) - first(b));
}

/** 자동 그룹: 계획을 미리보기 창에 보여 주고, 고른 것만 만듦 */
async function autoGroup() {
    const pm = promptManager;
    if (!pm?.activeCharacter) return;
    const order = pm.getPromptOrderForCharacter(pm.activeCharacter) || [];
    const getPrompt = id => pm.getPromptById(id);
    const plan = planAutoGroups(order, getPrompt);
    const data = presetData();
    const nameOf = id => String(getPrompt(id)?.name ?? id);
    const e = escapeHtml;
    let mode = data.groups.length ? 'free' : 'all';
    const picked = new Map();   // plan node → { on, name }
    const resetPicked = () => { picked.clear(); plan.flatMap(g => [g, ...g.children]).forEach(n => picked.set(n, { on: true, name: n.name })); };
    resetPicked();
    const open = new Set();   // 펼쳐 둔 줄
    const skip = new Set();   // 미리보기에서 체크를 푼 토글 — 어느 그룹에도 안 넣음

    const root = document.createElement('div');
    root.className = 'pf-editor pf-auto';
    root.innerHTML = `
        <h3 class="pf-ed-title">${e(tr`Auto-group preview`)}</h3>
        <div class="pf-ed-summary">${e(tr`Grouped by divider toggles and similar names. Untick what you don't want, fix names, then create.`)}</div>
        <div class="pf-auto-ai"><button type="button" class="menu_button pf-auto-ai-run"><i class="fa-solid fa-wand-magic-sparkles"></i><span>${e(tr`Regroup with AI`)}</span></button><small class="pf-auto-ai-note">${e(tr`Sends only the toggle names (not their text) once to the chosen connection.`)}</small>${aiPickersHtml()}</div>
        <div class="pf-ed-filter" role="radiogroup">
            <button type="button" class="pf-ed-chip" data-m="free" role="radio">${e(tr`Only toggles not in a group`)}</button>
            <button type="button" class="pf-ed-chip" data-m="all" role="radio">${e(tr`Regroup everything`)}</button>
        </div>
        <ul class="pf-auto-list"></ul>`;
    const list = root.querySelector('.pf-auto-list');

    const membersFor = n => {
        const grouped = mode === 'free' ? new Set(data.groups.flatMap(g => g.members)) : new Set();
        return n.members.filter(id => !grouped.has(id));
    };
    const keptFor = n => membersFor(n).filter(id => !skip.has(id));
    const render = () => {
        root.querySelectorAll('.pf-ed-chip').forEach(c => c.setAttribute('aria-checked', String(c.dataset.m === mode)));
        list.innerHTML = plan.length ? '' : `<li class="pf-auto-none">${e(tr`Couldn't find anything to group automatically in this preset.`)} ${e(tr`Try regrouping with AI.`)}</li>`;
        for (const g of plan) {
            const rowOf = (n, sub) => {
                const st = picked.get(n);
                const ids = membersFor(n);
                const total = keptFor(n).length + (sub ? 0 : n.children.reduce((s, c) => s + (picked.get(c).on ? keptFor(c).length : 0), 0));
                const li = document.createElement('li');
                li.className = 'pf-auto-row' + (sub ? ' pf-auto-sub' : '') + (st.on ? '' : ' pf-auto-off') + (total < 2 ? ' pf-auto-empty' : '');
                li.innerHTML = `
                    <input type="checkbox" ${st.on && total >= 2 ? 'checked' : ''} ${total < 2 ? 'disabled' : ''} aria-label="${e(tr`Create this group`)}">
                    <input type="text" class="text_pole pf-auto-name" value="${e(st.name)}" placeholder="${e(tr`No name — e.g. ${nameOf(ids[1] ?? ids[0] ?? '')}`)}">
                    <button type="button" class="pf-auto-count" aria-expanded="false" title="${e(tr`Show toggles`)}">${total}<i class="fa-solid fa-chevron-down"></i></button>
                    <ol class="pf-auto-items" hidden>${ids.map(id => `<li><label><input type="checkbox" data-id="${e(id)}" ${skip.has(id) ? '' : 'checked'}><span>${e(nameOf(id))}</span></label></li>`).join('')}</ol>`;
                li.querySelector('input[type=checkbox]').addEventListener('change', ev => { st.on = ev.target.checked; render(); });
                li.querySelectorAll('.pf-auto-items input[data-id]').forEach(box => box.addEventListener('change', () => {
                    if (box.checked) skip.delete(box.dataset.id); else skip.add(box.dataset.id);
                    open.add(n);
                    render();
                }));
                li.querySelector('.pf-auto-name').addEventListener('input', ev => { st.name = ev.target.value; });
                if (open.has(n)) { li.querySelector('.pf-auto-items').hidden = false; li.querySelector('.pf-auto-count').setAttribute('aria-expanded', 'true'); }
                li.querySelector('.pf-auto-count').addEventListener('click', ev => {
                    const ol = li.querySelector('.pf-auto-items');
                    ol.hidden = !ol.hidden;
                    if (ol.hidden) open.delete(n); else open.add(n);
                    ev.currentTarget.setAttribute('aria-expanded', String(!ol.hidden));
                });
                return li;
            };
            list.append(rowOf(g, false));
            g.children.forEach(c => list.append(rowOf(c, true)));
        }
    };
    root.querySelectorAll('.pf-ed-chip').forEach(c => c.addEventListener('click', () => { mode = c.dataset.m; render(); }));
    bindAiPickers(root);
    const aiBtn = root.querySelector('.pf-auto-ai-run');
    let running = null;
    aiBtn.addEventListener('click', async () => {
        const label = aiBtn.querySelector('span');
        if (running) { running.abort(); return; }   // 다시 누르면 멈춤
        if (!(await confirmAiSend(order.filter(x => getPrompt(x.identifier)).length))) return;
        running = new AbortController();
        const t0 = Date.now();
        const tick = () => { label.textContent = tr`AI is grouping… ${Math.round((Date.now() - t0) / 1000)}s (click to stop)`; };
        tick(); const timer = setInterval(tick, 1000);
        aiBtn.classList.add('pf-busy');
        try {
            const next = await aiPlan(order, getPrompt, running.signal);
            if (!next.length) { toastr.info(tr`AI found nothing to group.`, tr`Prompt Folders`); return; }
            plan.splice(0, plan.length, ...next);
            skip.clear(); open.clear(); resetPicked();
            mode = 'all';
            root.querySelector('.pf-ed-summary').textContent = tr`Grouped by AI. Untick what you don't want, fix names, then create.`;
            render();
        } catch (err) {
            if (!running?.signal.aborted) toastr.error(`${tr`Regroup with AI`}: ${String(err?.message || err)}`, tr`Prompt Folders`);
        } finally { clearInterval(timer); running = null; aiBtn.classList.remove('pf-busy'); label.textContent = tr`Regroup with AI`; }
    });
    render();

    const ok = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: tr`Create`, cancelButton: tr`Cancel`, wider: true, allowVerticalScrolling: true });
    if (!ok || !plan.length) return;
    const undo = structuredClone(data.groups);
    if (mode === 'all' && data.groups.length) {
        const sure = await callGenericPopup(escapeHtml(tr`Remove the current ${data.groups.length} groups of this preset and regroup? The toggles themselves are not changed.`), POPUP_TYPE.CONFIRM);
        if (!sure) return;
        data.groups = [];
    }
    const taken = new Set([...data.groups.flatMap(g => g.members), ...skip]);
    let made = 0;
    const nameFor = (n, ids) => (picked.get(n).name || '').trim() || nameOf(ids[1] ?? ids[0]).trim() || tr`Group ${data.groups.length + 1}`;
    for (const g of plan) {
        const kids = g.children.filter(c => picked.get(c).on).map(c => ({ c, ids: c.members.filter(id => !taken.has(id)) })).filter(k => k.ids.length >= 2);
        const direct = g.members.filter(id => !taken.has(id));
        // 하위 그룹으로 안 만든 하위 묶음의 토글은 큰 그룹에 바로
        g.children.filter(c => !kids.some(k => k.c === c)).forEach(c => direct.push(...c.members.filter(id => !taken.has(id))));
        if (!picked.get(g).on) {
            kids.forEach(k => { data.groups.push({ id: newId(), name: nameFor(k.c, k.ids), members: k.ids, parent: null, collapsed: true }); k.ids.forEach(id => taken.add(id)); made++; });
            continue;
        }
        if (direct.length + kids.reduce((s, k) => s + k.ids.length, 0) < 2) continue;
        const top = { id: newId(), name: nameFor(g, direct), members: direct, parent: null, collapsed: true };
        data.groups.push(top);
        direct.forEach(id => taken.add(id));
        made++;
        kids.forEach(k => { data.groups.push({ id: newId(), name: nameFor(k.c, k.ids), members: k.ids, parent: top.id, collapsed: true }); k.ids.forEach(id => taken.add(id)); made++; });
    }
    settings().view = 'grouped';
    save();
    apply();
    offerUndo(undo, tr`${made} groups created.`);
}

/** 이 프리셋의 그룹을 모두 풀기 (토글은 그대로) — 알림에서 되돌리기 */
async function ungroupAll() {
    const data = presetData();
    if (!data.groups.length) return;
    const ok = await callGenericPopup(escapeHtml(tr`Ungroup all ${data.groups.length} groups of this preset? The toggles themselves are not changed.`), POPUP_TYPE.CONFIRM);
    if (!ok) return;
    const undo = structuredClone(data.groups);
    data.groups = [];
    save();
    apply();
    offerUndo(undo, tr`All groups were ungrouped.`);
}

function exportGroups() {
    const data = { type: 'prompt-folders', version: 1, preset: presetKey(), groups: presetData().groups };
    const safe = presetKey().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
    download(JSON.stringify(data, null, 2), `prompt-folders - ${safe}.json`, 'application/json');
}

function importGroups() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            const json = JSON.parse(await getFileText(file));
            const groups = Array.isArray(json) ? json : json?.groups;
            if (!Array.isArray(groups) || !groups.every(g => g && typeof g.id === 'string' && typeof g.name === 'string' && Array.isArray(g.members))) {
                throw new Error('not a groups file');
            }
            const known = new Set((promptManager?.serviceSettings?.prompts || []).map(p => p.identifier));
            const matched = groups.reduce((n, g) => n + g.members.filter(id => known.has(id)).length, 0);
            const ok = await callGenericPopup(escapeHtml(tr`Replace the groups of "${presetKey()}" with ${groups.length} groups from the file? ${matched} items match this preset.`), POPUP_TYPE.CONFIRM);
            if (!ok) return;
            const undo = structuredClone(presetData().groups);
            presetData().groups = structuredClone(groups).map(g => ({ id: g.id, name: g.name, members: g.members, parent: g.parent || null, collapsed: !!g.collapsed, ...(g.color ? { color: g.color } : {}) }));
            save();
            apply();
            offerUndo(undo, tr`Groups imported.`);
        } catch (err) {
            console.warn('[Prompt Folders] import failed', err);
            toastr.error(tr`This file is not a Prompt Folders export.`, tr`Prompt Folders`);
        }
    });
    input.click();
}

/** 그룹 색 고르기: 서로 어울리는 견본 10개 + 자동(이모지·차례) + 직접 고르기 */
function pickColor(g, anchor) {
    closeGroupMenu();
    const menu = document.createElement('div');
    menu.className = 'pf-menu pf-swatch-menu';
    ['mousedown', 'touchstart'].forEach(type => menu.addEventListener(type, e => e.stopPropagation()));
    const set = color => {
        if (color) g.color = color; else delete g.color;
        closeGroupMenu();
        save();
        apply();
    };
    const tree = makeTree(presetData().groups);
    const auto = (() => { const c = g.color; delete g.color; const v = groupColor(g, tree.indexOf(g), tree); if (c) g.color = c; return v; })();
    menu.innerHTML = `
        <div class="pf-menu-info">${escapeHtml(tr`Group color`)}</div>
        <div class="pf-swatches" role="radiogroup">
            ${COLORS.map(c => `<button type="button" class="pf-swatch${g.color === c ? ' pf-swatch-on' : ''}" style="--sw:${c}" data-c="${c}" role="radio" aria-checked="${g.color === c}" aria-label="${c}"></button>`).join('')}
        </div>
        <div class="pf-menu-item pf-sw-auto"><span class="pf-swatch pf-swatch-mini${g.color ? '' : ' pf-swatch-on'}" style="--sw:${auto}"></span><span>${escapeHtml(tr`Automatic (from the emoji)`)}</span></div>
        <div class="pf-menu-item pf-sw-custom"><i class="fa-solid fa-eye-dropper"></i><span>${escapeHtml(tr`Custom color…`)}</span></div>`;
    menu.querySelectorAll('.pf-swatches .pf-swatch').forEach(b => b.addEventListener('click', () => set(b.dataset.c)));
    menu.querySelector('.pf-sw-auto').addEventListener('click', () => set(null));
    menu.querySelector('.pf-sw-custom').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'color';
        input.className = 'pf-color-input';
        input.value = /^#[0-9a-f]{6}$/i.test(g.color || auto) ? (g.color || auto) : '#8c93a3';
        document.body.append(input);
        input.addEventListener('change', () => { input.remove(); set(input.value); });
        input.addEventListener('blur', () => setTimeout(() => input.remove(), 0));
        input.click();
    });
    placeMenu(menu, anchor);
}

/** 원래 줄을 복사해서 그룹 안에 보여준다. 복사본은 실리태번 정렬 대상이 아니고(그룹 보기 끌기로 옮김),
 *  버튼을 누르면 숨겨진 원래 줄의 버튼을 대신 눌러준다. */
function cloneRow(orig) {
    const clone = orig.cloneNode(true);
    const id = orig.dataset.pmIdentifier;
    clone.classList.remove(DRAG_CLASS, 'pf-hidden');
    clone.classList.add('pf-clone');
    clone.removeAttribute('data-pm-identifier');
    clone.removeAttribute('id');
    clone.dataset.pfId = id;

    const proxy = sel => {
        clone.querySelectorAll(sel).forEach(el => el.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            orig.querySelector(sel)?.click();
        }));
    };
    proxy('.prompt-manager-toggle-action');
    proxy('.prompt-manager-edit-action');
    proxy('.prompt-manager-inspect-action');
    proxy('.prompt-manager-detach-action');
    return clone;
}

// ---------------- 동작 ----------------

// ---------------- 하나만 켜기 그룹 ----------------
// 그룹(하위 포함) 안에서 토글 하나를 켜면 나머지는 자동으로 끔. 언어·시점처럼 「택1」인 묶음용.

const enabledIds = () => new Set((promptManager?.getPromptOrderForCharacter(promptManager.activeCharacter) || []).filter(e => e.enabled).map(e => e.identifier));

function enforceExclusive(before, keepId = null) {
    const pm = promptManager;
    if (!pm?.activeCharacter) return 0;
    const data = presetData();
    const ex = data.groups.filter(g => g.exclusive);
    if (!ex.length) return 0;
    const tree = makeTree(data.groups);
    const order = pm.getPromptOrderForCharacter(pm.activeCharacter) || [];
    const turnedOn = keepId ? [keepId] : order.filter(e => e.enabled && !before.has(e.identifier)).map(e => e.identifier);
    let changed = 0;
    for (const id of turnedOn) {
        for (const g of ex) {
            const items = new Set(tree.allItems(g));
            if (!items.has(id)) continue;
            for (const e of order) if (e.enabled && e.identifier !== id && items.has(e.identifier)) { e.enabled = false; changed++; }
        }
    }
    if (changed) { pm.render(); pm.saveServiceSettings(); }
    return changed;
}

function setupExclusive() {
    if (window.__pfExclusiveHooked) return;
    window.__pfExclusiveHooked = true;
    // 토글 단추(원래 줄·그룹 안 복사본 모두)를 누르기 직전 상태를 기억했다가, 실리태번이 바꾼 뒤 비교
    document.addEventListener('click', e => {
        if (!e.target.closest?.('.prompt-manager-toggle-action')) return;
        const before = enabledIds();
        setTimeout(() => enforceExclusive(before), 0);
    }, true);
}

function setExclusive(g, on) {
    g.exclusive = on || undefined;
    if (!g.exclusive) delete g.exclusive;
    save();
    if (on) {
        // 이미 여러 개가 켜져 있으면 실제 순서에서 첫 번째만 남김
        const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter) || [];
        const items = new Set(makeTree(presetData().groups).allItems(g));
        const first = order.find(e => e.enabled && items.has(e.identifier));
        if (first && enforceExclusive(new Set(), first.identifier)) toastr.info(tr`Kept only "${promptManager.getPromptById(first.identifier)?.name ?? first.identifier}" on in this group.`, tr`Prompt Folders`);
    }
    apply();
}

// ---------------- 되돌리기 ----------------
function offerUndo(snapshot, message) {
    const key = presetKey();
    toastr.success(`${escapeHtml(message)} <u>${escapeHtml(tr`Undo`)}</u>`, tr`Prompt Folders`, {
        escapeHtml: false,
        timeOut: 10000,
        extendedTimeOut: 4000,
        onclick: () => {
            settings().presets[key] = { ...(settings().presets[key] || {}), groups: snapshot };
            save();
            apply();
            toastr.info(tr`Restored the previous groups.`, tr`Prompt Folders`);
        },
    });
}

function setAllCollapsed(collapsed) {
    presetData().groups.forEach(g => { g.collapsed = collapsed; });
    save();
    apply();
}

function toggleAll(ids, target) {
    const pm = promptManager;
    if (!pm || !pm.activeCharacter) return;
    const counts = pm.tokenHandler?.getCounts?.() ?? {};
    ids.forEach(id => {
        const prompt = pm.getPromptById(id);
        if (!prompt || !pm.isPromptToggleAllowed(prompt)) return;
        const entry = pm.getPromptOrderEntry(pm.activeCharacter, id);
        if (!entry) return;
        entry.enabled = target;
        counts[id] = null;
    });
    pm.render();
    pm.saveServiceSettings();
}

function createGroup(parentId = null) {
    return openEditor(null, parentId);
}

function startEditing(g) {
    return openEditor(g, g.parent || null);
}

/** 그룹 편집 창: 이름 · 넣을 곳 · 검색 · 체크로 여러 개 고르기 (Shift+클릭 범위, 끌어서 칠하기) */
async function openEditor(g, parentId) {
    const pm = promptManager;
    if (!pm?.activeCharacter) return;
    const data = presetData();
    const tree = makeTree(data.groups);
    const rawOrder = pm.getPromptOrderForCharacter(pm.activeCharacter) || [];
    const hdr = findHeaders(rawOrder, id => pm.getPromptById(id));
    const order = rawOrder.map((e, i) => {
        const p = pm.getPromptById(e.identifier);
        return { id: e.identifier, pos: i + 1, name: String(p?.name ?? e.identifier), on: !!e.enabled, divider: hdr.has(e.identifier) };
    });
    const groupOf = new Map();
    data.groups.forEach(x => x.members.forEach(id => groupOf.set(id, x)));
    // 편집: 하위 그룹에 든 토글까지 체크된 채로 (그룹 전체를 다룸)
    const selected = new Set(g ? makeTree(data.groups).allItems(g) : []);
    const e = escapeHtml;

    const root = document.createElement('div');
    root.className = 'pf-editor';
    const parents = data.groups.filter(x => !g || (x !== g && !tree.isDescendant(x, g)));
    root.innerHTML = `
        <h3 class="pf-ed-title">${e(g ? tr`Edit "${g.name}"` : tr`New group`)}</h3>
        ${g && tree.childrenOf(g).length ? `<div class="pf-ed-summary">${e(tr`Includes ${tree.childrenOf(g).length} sub-groups. Checked toggles stay where they are; unchecking removes them from this group.`)}</div>` : ''}
        <div class="pf-ed-fields">
            <label class="pf-ed-field"><span>${e(tr`Name`)}</span><input type="text" class="text_pole pf-ed-name" value="${e(g?.name ?? '')}" placeholder="${e(tr`Name of the new group`)}"></label>
            <label class="pf-ed-field"><span>${e(tr`Inside`)}</span><select class="text_pole pf-ed-parent">
                <option value="">${e(tr`Top level`)}</option>
                ${parents.map(x => `<option value="${e(x.id)}" ${x.id === parentId ? 'selected' : ''}>${e(tree.path(x).map(y => y.name).join(' › '))}</option>`).join('')}
            </select></label>
        </div>
        <div class="pf-ed-bar">
            <label class="pf-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" placeholder="${e(tr`Search toggles`)}" aria-label="${e(tr`Search toggles`)}"></label>
            <button type="button" class="pf-tb pf-ed-all">${e(tr`Select shown`)}</button>
            <button type="button" class="pf-tb pf-ed-none">${e(tr`Clear`)}</button>
        </div>
        <div class="pf-ed-filter" role="radiogroup">
            <button type="button" class="pf-ed-chip" data-f="all" role="radio">${e(tr`All`)}</button>
            ${g ? `<button type="button" class="pf-ed-chip" data-f="mine" role="radio">${e(tr`This group`)}</button>` : ''}
            <button type="button" class="pf-ed-chip" data-f="free" role="radio">${e(tr`Not in a group`)}</button>
        </div>
        <div class="pf-ed-meta"><span class="pf-ed-count"></span><span class="pf-ed-hint">${e(matchMedia('(pointer: coarse)').matches ? tr`Pick many: long-press, then drag` : tr`Pick many: drag · Shift+click for a range`)}</span></div>
        <ul class="pf-ed-list" role="listbox" aria-multiselectable="true"></ul>`;
    const list = root.querySelector('.pf-ed-list');
    const count = root.querySelector('.pf-ed-count');
    const updateCount = () => { count.textContent = tr`${selected.size} selected`; };

    for (const it of order) {
        const li = document.createElement('li');
        li.className = 'pf-ed-row' + (it.divider ? ' pf-ed-div' : '') + (it.on ? '' : ' pf-ed-off');
        li.dataset.id = it.id;
        li.setAttribute('role', 'option');
        const other = groupOf.get(it.id);
        const tag = other && other !== g ? `<span class="pf-ed-tag" style="--pf-color:${groupColor(other, tree.indexOf(other), tree)}">${e(tree.path(other).map(y => y.name).join(' › '))}</span>` : '';
        li.innerHTML = `<input type="checkbox" tabindex="-1"><span class="pf-ed-pos">#${it.pos}</span><span class="pf-ed-name-text">${e(it.name)}</span>${tag}`;
        list.append(li);
    }
    const rows = [...list.children];
    const setRow = (li, on) => {
        li.querySelector('input').checked = on;
        li.classList.toggle('pf-ed-sel', on);
        li.setAttribute('aria-selected', String(on));
        if (on) selected.add(li.dataset.id); else selected.delete(li.dataset.id);
    };
    rows.forEach(li => setRow(li, selected.has(li.dataset.id)));
    updateCount();

    // 마우스: 누르기 · Shift+클릭 범위 · 누른 채 끌어서 칠하기
    // 터치: 손을 뗄 때 고르기(스크롤과 안 겹치게) · 길게 누르면 그 줄을 고르고, 그대로 끌면 지나간 줄도 같이 (끄는 동안 스크롤 막음)
    let last = null, paint = null, press = null;
    const rangeTo = (idx, on) => {
        const [a, b] = [Math.min(last, idx), Math.max(last, idx)];
        for (let i = a; i <= b; i++) if (!rows[i].hidden) setRow(rows[i], on);
    };
    list.addEventListener('pointerdown', ev => {
        const li = ev.target.closest('.pf-ed-row');
        if (!li || ev.button !== 0) return;
        const idx = rows.indexOf(li);
        if (ev.pointerType !== 'mouse') {
            press = { li, idx, x: ev.clientX, y: ev.clientY, long: false };
            press.timer = setTimeout(() => {
                if (!press) return;
                press.long = true;
                paint = !selected.has(li.dataset.id);
                setRow(li, paint);
                last = idx;
                updateCount();
                navigator.vibrate?.(12);
            }, 450);
            return;
        }
        ev.preventDefault();
        const on = !selected.has(li.dataset.id);
        if (ev.shiftKey && last != null) rangeTo(idx, on);
        else { setRow(li, on); paint = on; }
        last = idx;
        updateCount();
    });
    list.addEventListener('touchmove', ev => {
        if (!press?.long || paint === null) return;
        ev.preventDefault();
        const t = ev.touches[0];
        const li = document.elementFromPoint(t.clientX, t.clientY)?.closest?.('.pf-ed-row');
        if (li && list.contains(li) && !li.hidden) { setRow(li, paint); updateCount(); }
    }, { passive: false });
    list.addEventListener('pointermove', ev => {
        if (press?.long) return;
        if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 8) { clearTimeout(press.timer); press = null; }
    });
    list.addEventListener('pointerup', () => {
        if (!press) return;
        clearTimeout(press.timer);
        if (!press.long) {
            setRow(press.li, !selected.has(press.li.dataset.id));
            last = press.idx;
            updateCount();
        }
        press = null;
    });
    list.addEventListener('pointercancel', () => { if (press && !press.long) { clearTimeout(press.timer); press = null; } });
    list.addEventListener('touchend', () => { if (press?.long) { press = null; paint = null; } });
    list.addEventListener('contextmenu', ev => { if (ev.target.closest('.pf-ed-row')) ev.preventDefault(); });
    list.addEventListener('pointerover', ev => {
        if (paint === null) return;
        const li = ev.target.closest('.pf-ed-row');
        if (li) { setRow(li, paint); updateCount(); }
    });
    const stopPaint = () => { paint = null; };
    document.addEventListener('pointerup', stopPaint);
    list.addEventListener('click', ev => ev.preventDefault());

    const search = root.querySelector('.pf-search input');
    // 보기 거르기: 전체 / 이 그룹(하위 그룹 포함) / 그룹 없음 + 검색
    const inThis = new Set(g ? tree.allItems(g) : []);
    let filter = g && inThis.size ? 'mine' : 'all';
    const refilter = () => {
        const q = search.value.trim().toLowerCase();
        rows.forEach((li, i) => {
            const id = order[i].id;
            const okF = filter === 'all' || (filter === 'mine' ? (inThis.has(id) || selected.has(id)) : !groupOf.has(id) || (g && groupOf.get(id) === g));
            li.hidden = !okF || (!!q && !order[i].name.toLowerCase().includes(q));
        });
        root.querySelectorAll('.pf-ed-chip').forEach(c => c.setAttribute('aria-checked', String(c.dataset.f === filter)));
    };
    root.querySelectorAll('.pf-ed-chip').forEach(c => c.addEventListener('click', () => { filter = c.dataset.f; refilter(); }));
    search.addEventListener('input', refilter);
    refilter();
    root.querySelector('.pf-ed-all').addEventListener('click', () => { rows.forEach(li => { if (!li.hidden) setRow(li, true); }); updateCount(); });
    root.querySelector('.pf-ed-none').addEventListener('click', () => { rows.forEach(li => setRow(li, false)); updateCount(); });

    const ok = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: tr`Save`, cancelButton: tr`Cancel`, wider: true, allowVerticalScrolling: true });
    document.removeEventListener('pointerup', stopPaint);
    if (!ok) return;

    const name = root.querySelector('.pf-ed-name').value.trim() || (g?.name ?? tr`Group ${data.groups.length + 1}`);
    const parent = root.querySelector('.pf-ed-parent').value || null;
    const known = new Set(order.map(x => x.id));
    const subtree = g ? [g, ...data.groups.filter(x => tree.isDescendant(x, g))] : [];
    const had = new Set(subtree.flatMap(x => x.members));
    // 새로 체크한 토글: 다른 그룹에서 빼고 이 그룹에 바로 넣음 (실제 순서대로)
    const added = order.map(x => x.id).filter(id => selected.has(id) && !had.has(id));
    const addSet = new Set(added);
    data.groups.forEach(x => { if (!subtree.includes(x)) x.members = x.members.filter(id => !addSet.has(id)); });
    // 체크를 푼 토글: 이 그룹(하위 포함)에서 뺌 — 지금 목록에 없는 기존 멤버는 그대로
    subtree.forEach(x => { x.members = x.members.filter(id => selected.has(id) || !known.has(id)); });
    if (g) {
        g.name = name;
        const at = new Map(order.map((x, i) => [x.id, i]));
        g.members = [...g.members, ...added].sort((p, q) => (at.get(p) ?? 1e9) - (at.get(q) ?? 1e9));
        g.parent = parent;
    } else {
        data.groups.push({ id: newId(), name, members: added, parent, collapsed: false });
    }
    if (parent) { const p = data.groups.find(x => x.id === parent); if (p) p.collapsed = false; }
    settings().view = 'grouped';
    save();
    apply();
}


async function deleteGroup(g) {
    const ok = await callGenericPopup(`${escapeHtml(tr`Ungroup "${g.name}"?`)}<br><small>${escapeHtml(tr`The toggles inside are not deleted and stay where they are. Groups inside move up one level.`)}</small>`, POPUP_TYPE.CONFIRM);
    if (!ok) return;
    const data = presetData();
    data.groups.forEach(x => { if (x.parent === g.id) x.parent = g.parent || null; });
    data.groups = data.groups.filter(x => x.id !== g.id);
    save();
    apply();
}

// ---------------- 감시 ----------------

function scheduleApply() {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(apply, 30);
}

function pause() {
    observer?.disconnect();
}

function resume() {
    const container = document.getElementById(CONTAINER_ID);
    if (observer && container) observer.observe(container, { childList: true, subtree: true });
}

function init() {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) {
        setTimeout(init, 1000);
        return;
    }
    settings();
    addSettingsPanel();
    setupExclusive();
    // 다른 프리셋을 고르면 그 프리셋의 그룹으로 다시 그림
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, scheduleApply);
    observer = new MutationObserver(mutations => {
        // ST가 목록을 다시 그렸거나 줄 순서가 바뀐 경우에만 다시 적용
        const relevant = mutations.some(m => [...m.addedNodes, ...m.removedNodes].some(n =>
            n.nodeType === 1 && !(n.classList?.contains('pf-group') || n.classList?.contains('pf-toolbar') || n.classList?.contains('pf-end-zone') || n.classList?.contains('ui-sortable-placeholder') || n.classList?.contains('cpm-bar') || n.classList?.contains('pf-empty'))));
        if (relevant) scheduleApply();
    });
    resume();
    apply();
}

// ---------------- 설정 화면 ----------------

async function addSettingsPanel() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('pf_settings')) return;
    try {
        const html = await (await fetch(new URL('settings.html', import.meta.url))).text();
        host.insertAdjacentHTML('beforeend', html);
    } catch (err) {
        console.warn('[Prompt Folders] settings panel', err);
        return;
    }
    const ly = document.getElementById('pf_layout');
    if (ly) {
        ly.value = settings().layout || 'real';
        ly.addEventListener('change', () => { settings().layout = ly.value; saveSettingsDebounced(); apply(); });
    }
    const aiHost = document.getElementById('pf_ai_host');
    if (aiHost) { aiHost.innerHTML = aiPickersHtml(); bindAiPickers(aiHost); }
    const cs = document.getElementById('pf_colorStyle');
    if (cs) {
        cs.value = settings().colorStyle || 'dot';
        cs.addEventListener('change', () => { settings().colorStyle = cs.value; saveSettingsDebounced(); apply(); });
    }
    for (const key of ['showPos', 'wrapNames', 'syncPreset']) {
        const cb = document.getElementById(`pf_${key}`);
        if (!cb) continue;
        cb.checked = !!settings()[key];
        cb.addEventListener('change', () => {
            settings()[key] = cb.checked;
            saveSettingsDebounced();
            if (key === 'syncPreset' && cb.checked) syncToPreset();
            apply();
        });
    }
}

jQuery(async () => {
    await loadKo();
    init();
});

