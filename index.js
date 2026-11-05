// Prompt Folders — group Prompt Manager toggles into collapsible, nestable folders.
// Groups are display-only: prompt_order is only changed when you drag an item to a new place.
// Each row shows its real position (#n). Groups are stored per preset name in the extension settings,
// and mirrored into the preset file (extensions.promptFolders) so they travel with a shared preset.

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import * as stScript from '../../../../script.js';   // isGenerating 은 판마다 있을 수도 없을 수도 있어서 이름공간으로
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
    applyFolds(k, s.presets[k]);
    return s.presets[k];
}

// 접고 펼친 상태는 브라우저 저장소에 바로 적고 실리태번 설정 저장은 부르지 않음 —
// 설정 파일이 크면 저장 한 번에 화면이 0.1초 넘게 멈춰서 열고 닫을 때마다 「뚝」 끊겼음.
// 메모리의 g.collapsed 도 같이 바꾸므로 다음에 다른 이유로 설정이 저장될 때 함께 들어감.
const FOLD_KEY = 'promptFolders.collapsed.v1';
let foldCache = null;
const foldsApplied = new Set();
function foldStore() {
    if (!foldCache) {
        try { foldCache = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}; } catch { foldCache = {}; }
    }
    return foldCache;
}
function applyFolds(key, data) {
    if (foldsApplied.has(key)) return;
    foldsApplied.add(key);
    const saved = foldStore()[key];
    if (!saved) return;
    for (const g of data.groups || []) if (g.id in saved) g.collapsed = !!saved[g.id];
}
function rememberFolds(groups) {
    const st = foldStore();
    const map = (st[presetKey()] ||= {});
    for (const g of groups) map[g.id] = !!g.collapsed;
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(st)); } catch { /* 저장소를 못 쓰면 메모리에만 */ }
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
    // 하위 그룹은 이모지와 상관없이 상위 그룹 색(직접 고른 색만 예외) — 2026-11-04 사용자
    const parent = tree?.parentOf(g);
    if (parent) return groupColor(parent, tree.indexOf(parent), tree);
    const fromEmoji = emojiColor(g.name);
    if (fromEmoji) return fromEmoji;
    if (tree) {
        // 큰 묶음은 이모지 색, 없으면 팔레트 색 — 한 번 정하면 그룹에 적어 둬서(slot) 순서가 바뀌어도 안 밀림
        if (!Number.isInteger(g.slot)) assignSlot(g, tree);
        return COLORS[g.slot % COLORS.length];
    }
    return COLORS[i % COLORS.length];
}

const LEAD_EMOJI = /^\s*((?:\p{Regional_Indicator}{2})|(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*))/u;
// 이모지 색은 한 번 뽑으면 브라우저에 기억 (다음에 열 때 캔버스로 다시 안 그림)
/** 큰 그룹의 팔레트 자리 정하기: 처음(아무도 자리가 없을 때)은 지금 차례 그대로 → 보이는 색이 안 바뀜, 그 뒤 새 그룹은 가장 덜 쓴 색 */
function assignSlot(g, tree) {
    const tops = tree.tops;
    if (!tops.some(t => Number.isInteger(t.slot))) {
        tops.forEach((t, i) => { t.slot = i % COLORS.length; });
    } else {
        const used = COLORS.map((_, i) => tops.filter(t => t !== g && t.slot === i).length);
        g.slot = used.indexOf(Math.min(...used));
    }
    save();
}

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
    const snap = takeSnap();
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
    offerRestore(snap, tr`Moved the group "${g.name}".`);
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
            ${ib('pf-edit', groups.length ? 'fa-pen-to-square' : 'fa-folder-plus', groups.length ? tr`Edit groups` : tr`New group`)}
            ${groups.length ? '' : ib('pf-auto', 'fa-wand-magic-sparkles', tr`Auto-group`)}
            ${groups.length ? ib('pf-view', 'fa-list-ol', view === 'original' ? tr`Show with groups` : tr`Show without groups`, `aria-pressed="${view === 'original'}"`) : ''}
            ${groups.length ? ib('pf-fold' + (view === 'original' ? ' pf-ib-gone' : ''), anyOpen ? 'fa-angles-up' : 'fa-angles-down', anyOpen ? tr`Collapse all` : tr`Expand all`, view === 'original' ? 'aria-hidden="true" tabindex="-1"' : '') : ''}
            ${ib('pf-tools', 'fa-ellipsis', tr`Import / export groups`)}`;
        // 전체 그룹 편집은 여기 한 곳 (새 그룹은 편집기 안 「+ 그룹 만들기」로) — 그룹이 하나도 없으면 빈 새 그룹을 만들어 둔 채로
        bar.querySelector('.pf-edit').addEventListener('click', () => (presetData().groups.length ? openGroupEditor({}) : createGroup(null)));
        bar.querySelector('.pf-auto')?.addEventListener('click', autoGroup);
        bar.querySelector('.pf-tools').addEventListener('click', ev => openToolsMenu(ev.currentTarget));
        bar.querySelector('.pf-view')?.addEventListener('click', () => {
            settings().view = view === 'original' ? 'grouped' : 'original';
            save();
            apply();
        });
        // 그룹 하나를 열고 닫아도 목록을 다시 그리지 않으므로, 누르는 순간의 상태로 정함
        bar.querySelector('.pf-fold:not(.pf-ib-gone)')?.addEventListener('click', () => setAllCollapsed(presetData().groups.some(g => !g.collapsed)));
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
    return { byId, parentOf, childrenOf, isDescendant, allItems, path, indexOf, topIndexOf, tops };
}

// ---------- 토글 즉시 반영 ----------
// 실리태번은 토글을 누르면 토큰 세기용 시험 생성(긴 채팅이면 0.3~0.5초)을 끝낸 뒤에야 목록 전체를 다시 그리고,
// 우리는 그걸 받아 그룹을 다시 지었음 → 누를 때마다 1초 가까이 멈춤. 이제 켬/끔은 그 자리에서만 바꾸고 저장은 실리태번 함수로,
// 토큰 수는 마지막으로 누르고 조금 뒤에 한 번만 세서 숫자만 고침.
const DISABLED = 'completion_prompt_manager_prompt_disabled';
const liveOn = () => new Map((promptManager?.getPromptOrderForCharacter(promptManager.activeCharacter) || []).map(e => [e.identifier, !!e.enabled]));

/** 그룹 머리 값: 켜진 수 · 모두 켜짐 · 켜진 토큰 · 실제 위치 범위 (줄의 꺼짐 표시 기준) */
function headState(g, items, rowById, pos) {
    const isOff = id => rowById.get(id)?.classList.contains(DISABLED);
    const enabledCount = items.filter(id => !isOff(id)).length;
    const tokens = items.reduce((sum, id) => {
        if (isOff(id)) return sum;
        const t = Number(rowById.get(id)?.querySelector('.prompt_manager_prompt_tokens')?.dataset.pmTokens);
        return sum + (Number.isFinite(t) ? t : 0);
    }, 0);
    const range = items.length ? `#${pos.get(items[0])}${items.length > 1 ? '~#' + pos.get(items[items.length - 1]) : ''}` : tr`no items`;
    return { enabledCount, allOn: items.length > 0 && enabledCount === items.length, tokens, range };
}

/** 그룹 머리의 켜짐 수 · 흐림 · 전체 스위치 · 풍선 글을 지금 상태로 */
function paintHead(head, g, items, rowById, pos, tree) {
    const { enabledCount, allOn, tokens, range } = headState(g, items, rowById, pos);
    const subCount = tree.childrenOf(g).length;
    // 바뀐 것만 씀 — 같은 값을 다시 써도 화면 다시 계산 · 다른 확장의 감시가 돌아서 (토글 하나에 머리 35개를 다 쓰면 0.2초 넘게 걸렸음)
    const cls = (el, c, v) => { if (el.classList.contains(c) !== v) el.classList.toggle(c, v); };
    const attr = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
    cls(head, 'pf-all-off', !!items.length && !enabledCount);   // 다 꺼진 그룹은 꺼진 토글 줄처럼 흐리게
    attr(head, 'title', [g.name, tr`On ${enabledCount}/${items.length} · real position ${range}`,
        subCount ? tr`${subCount} sub-groups` : '', tokens ? tr`Tokens of enabled items: ${tokens}` : ''].filter(Boolean).join('\n'));
    const count = head.querySelector('.pf-count');
    const text = `${enabledCount}/${items.length}`;
    if (count && count.textContent !== text) { if (count.firstChild?.nodeType === Node.TEXT_NODE) count.firstChild.data = text; else count.textContent = text; }
    const sw = head.querySelector('.pf-toggle-all');
    if (sw) {
        const on = g.exclusive ? enabledCount > 0 : allOn;
        cls(sw, 'fa-toggle-on', on);
        cls(sw, 'fa-toggle-off', !on);
        cls(sw, 'pf-btn-idle', !!g.exclusive && !enabledCount);
        attr(sw, 'title', g.exclusive ? (enabledCount ? tr`Turn the whole group off` : tr`Turn one toggle on from inside the group`) : (allOn ? tr`Turn the whole group off` : tr`Turn the whole group on`));
    }
}

/** 줄(원래 줄 · 그룹 안 복사본)과 그룹 머리를 지금 켬/끔 상태로 — 목록을 다시 그리지 않음 */
function paintStates() {
    const list = document.getElementById(LIST_ID);
    if (!list || !promptManager?.activeCharacter) return;
    const on = liveOn();
    list.querySelectorAll(`${ROW_SEL}, li.pf-clone[data-pf-id]`).forEach(row => {
        const id = row.dataset.pmIdentifier || row.dataset.pfId;
        if (!on.has(id)) return;
        const v = on.get(id);
        if (row.classList.contains(DISABLED) === v) row.classList.toggle(DISABLED, !v);
        const t = row.querySelector('.prompt-manager-toggle-action');
        if (t && t.classList.contains('fa-toggle-on') !== v) { t.classList.toggle('fa-toggle-on', v); t.classList.toggle('fa-toggle-off', !v); }
    });
    const heads = list.querySelectorAll('li.pf-group > .pf-group-head');
    if (!heads.length) return;
    const rows = [...list.querySelectorAll(ROW_SEL)];
    const rowById = new Map(rows.map(r => [r.dataset.pmIdentifier, r]));
    const pos = new Map(rows.map((r, i) => [r.dataset.pmIdentifier, i + 1]));
    const groups = presetData().groups, tree = makeTree(groups);
    heads.forEach(head => {
        const g = groups.find(x => x.id === head.parentElement.dataset.pfGroup);
        if (!g) return;
        const items = tree.allItems(g).filter(id => rowById.has(id)).sort((a, b) => pos.get(a) - pos.get(b));
        paintHead(head, g, items, rowById, pos, tree);
    });
}

let tokenTimer = null;
/** 켬/끔을 바꾼 뒤: 화면은 바로, 저장은 실리태번 함수로(설정 저장 이벤트를 다른 확장도 받음), 토큰 수는 조금 뒤 한 번 */
function commitToggles(ids = []) {
    const counts = promptManager?.tokenHandler?.getCounts?.();
    if (counts) ids.forEach(id => { counts[id] = null; });
    paintStates();
    promptManager?.saveServiceSettings();
    clearTimeout(tokenTimer);
    tokenTimer = setTimeout(recountTokens, 800);
}

/** 토큰 수만 다시 세어 숫자만 고침 (생성 중이면 실리태번에 맡김 — 끝난 뒤 알아서 다시 그림) */
async function recountTokens() {
    const pm = promptManager;
    if (!pm?.activeCharacter) return;
    if (drag?.started) { tokenTimer = setTimeout(recountTokens, 800); return; }
    if (typeof stScript.isGenerating !== 'function' || stScript.isGenerating()) return void pm.render();
    try { await pm.tryGenerate(); } catch (err) { console.warn('[Prompt Folders] token count', err); return void pm.render(); }
    const list = document.getElementById(LIST_ID);
    if (!list) return;
    const counts = pm.tokenHandler?.getCounts?.() || {};
    list.querySelectorAll(`${ROW_SEL}, li.pf-clone[data-pf-id]`).forEach(row => {
        const id = row.dataset.pmIdentifier || row.dataset.pfId;
        const el = row.querySelector('.prompt_manager_prompt_tokens');
        if (!el) return;
        const v = String(counts[id] || '-');
        if (el.dataset.pmTokens === v) return;
        el.dataset.pmTokens = v;
        const last = el.lastChild;
        if (last?.nodeType === Node.TEXT_NODE) last.textContent = v; else el.append(v);
    });
    // 맨 위 「총 토큰」 숫자
    const total = document.querySelector(`#${CONTAINER_ID} .completion_prompt_manager_header > div:last-child`);
    const tn = total && [...total.childNodes].reverse().find(n => n.nodeType === Node.TEXT_NODE && /\d/.test(n.textContent));
    if (tn) tn.textContent = ` ${pm.tokenUsage} `;
    paintStates();   // 그룹 머리 풍선의 토큰 합도
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

    const { enabledCount, allOn, range } = headState(g, items, rowById, pos, tree);
    const exclusive = !!g.exclusive;
    const subCount = tree.childrenOf(g).length;

    const head = document.createElement('div');
    head.className = 'pf-group-head';
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(open));
    head.tabIndex = 0;
    head.innerHTML = `
        <span class="pf-caret fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'}"></span>
        ${subCount ? '<span class="pf-folder fa-solid fa-folder-tree"></span>' : ''}
        <span class="pf-name">${escapeHtml(g.name)}</span>
        <span class="pf-btn pf-one${exclusive ? '' : ' pf-one-off'}" role="button" tabindex="0" aria-pressed="${exclusive}" title="${escapeHtml(exclusive ? tr`Only one toggle in this group can be on. Click to turn off.` : tr`Click to allow only one toggle on in this group`)}">${escapeHtml(tr`Pick 1`)}</span>
        <span class="pf-count">${enabledCount}/${items.length}</span>
        ${exclusive
        ? `<span class="pf-btn pf-toggle-all fa-solid ${enabledCount ? 'fa-toggle-on' : 'fa-toggle-off pf-btn-idle'}" role="button" title="${escapeHtml(enabledCount ? tr`Turn the whole group off` : tr`Turn one toggle on from inside the group`)}"></span>`
        : `<span class="pf-btn pf-toggle-all fa-solid ${allOn ? 'fa-toggle-on' : 'fa-toggle-off'}" role="button" title="${escapeHtml(allOn ? tr`Turn the whole group off` : tr`Turn the whole group on`)}"></span>`}
        <span class="pf-btn pf-more fa-solid fa-ellipsis-vertical" role="button" title="${escapeHtml(tr`Group menu`)}"></span>`;
    paintHead(head, g, items, rowById, pos, tree);
    li.append(head);

    // 열고 닫기는 목록을 다시 그리지 않고 이 그룹만 바꿈(접힌 그룹도 안은 그려 둠)
    const toggleOpen = () => {
        g.collapsed = !g.collapsed;
        rememberFolds([g]);
        animateGroup(li, body, head, !g.collapsed);
    };
    head.addEventListener('click', e => { if (!e.target.closest('.pf-btn')) toggleOpen(); });
    head.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === head) { e.preventDefault(); toggleOpen(); } });
    head.querySelector('.pf-toggle-all').addEventListener('click', () => {
        const snap = takeSnap();
        const live = liveOn();
        const n = items.filter(id => live.get(id)).length, every = items.length > 0 && n === items.length;
        if (exclusive) { if (n) { toggleAll(items, false); offerRestore(snap, tr`Turned off "${g.name}".`); } return; }
        toggleAll(items, !every);
        offerRestore(snap, every ? tr`Turned off "${g.name}".` : tr`Turned on all of "${g.name}".`);
    });
    head.querySelector('.pf-more').addEventListener('click', e => openGroupMenu(g, e.currentTarget, range));
    // 머리의 「택1」을 바로 눌러 켜고 끔 (편집 창 · 메뉴를 거치지 않음)
    const one = head.querySelector('.pf-one');
    one.addEventListener('click', () => setExclusive(g, !g.exclusive));
    one.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExclusive(g, !g.exclusive); } });

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

function animateGroup(li, body, head, open) {
    // 움직임 없이 바로 열고 닫음(사용자: 움직이는 게 더 거슬림) — 목록 전체를 다시 그리지 않는 것만 남김
    head.setAttribute('aria-expanded', String(open));
    const caret = head.querySelector('.pf-caret');
    caret?.classList.toggle('fa-chevron-down', open);
    caret?.classList.toggle('fa-chevron-right', !open);
    li.classList.toggle('pf-collapsed', !open);
    syncFoldButton();
}

/** 도구 줄 「모두 접기 / 모두 펼치기」 아이콘을 지금 상태에 맞춤 */
function syncFoldButton() {
    const btn = document.querySelector('.pf-toolbar .pf-fold');
    if (!btn) return;
    const anyOpen = presetData().groups.some(g => !g.collapsed);
    const label = anyOpen ? tr`Collapse all` : tr`Expand all`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.querySelector('i')?.classList.toggle('fa-angles-up', anyOpen);
    btn.querySelector('i')?.classList.toggle('fa-angles-down', !anyOpen);
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
    item('fa-pen-to-square', escapeHtml(tr`Edit this group`), () => startEditing(g));
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
    // 단추 바로 아래, 안 들어가면 바로 위 — 둘 다 모자라면 넓은 쪽에 붙이고 메뉴 안에서 스크롤 (화면 맨 위로 튀지 않게)
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    const down = mh <= below || (mh > above && below >= above);
    if (mh > (down ? below : above)) { menu.style.maxHeight = (down ? below : above) + 'px'; menu.style.overflowY = 'auto'; }
    const y = down ? r.bottom + 4 : r.top - 4 - Math.min(mh, above);
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
    item('fa-code-branch', tr`Bring groups from another preset`, importFromPreset);
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
// 글자 나누기(Intl.Segmenter)가 자동 그룹 계산 시간의 대부분이라 같은 글은 한 번만 나눔 (돌려줄 땐 복사본 — 받은 쪽이 뒤집어도 괜찮게)
const graphemeCache = new Map();
const graphemes = s => {
    s = String(s);
    let g = graphemeCache.get(s);
    if (!g) {
        if (graphemeCache.size > 20000) graphemeCache.clear();
        g = segmenter ? Array.from(segmenter.segment(s), x => x.segment) : Array.from(s);
        graphemeCache.set(s, g);
    }
    return g.slice();
};
const isWordG = g => /[\p{Lu}\p{Ll}\p{Lt}\p{Lo}\p{N}]/u.test(g);   // ﾟ 같은 수식 기호(Lm)는 글자가 아님
// 한자 · 가나는 낱말 사이 띄어쓰기가 없어 글자마다 끊을 수 있음 (①② 같은 동그라미 숫자도)
const isCJ = g => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{No}]/u.test(g);
const glued = (a, b) => isWordG(a) && isWordG(b) && !isCJ(a) && !isCJ(b);
// 끝 표시 말: end · 종료 · 结束 · 終了, 「끝」은 글자 맨 끝에 올 때만 (끝맺음 · 끝없는 은 아님)
const END_WORD = /\bend\b|종료|结束|終了|끝(?=[^\p{L}\p{N}]*$)/iu;
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
    const byText = new Map(), twins = new Set();
    // 실리태번 기본 자리(카드 · 채팅 자리 표시는 빼고)를 이름만 바꿔 구역 머리로 쓰는 프리셋도 있어서 그것도 봄
    order.map(e => e.identifier).filter(id => getPrompt(id) && !getPrompt(id).marker).forEach(id => {
        const t = lettersOnly(getPrompt(id).name);
        if (t) byText.set(t, [...(byText.get(t) || []), id]);
    });
    byText.forEach(ids => {
        // 뒤의 것(끝 표시)은 거의 비고(40자 미만) 앞의 것(구역 머리)도 짧으면(300자 미만) 짝 — 「머리 + 같은 이름의 본문」은 짝이 아님
        const lens = ids.map(id => (headers.has(id) ? 0 : contentLen(getPrompt(id))));
        if (ids.length === 2 && ids.some(id => decoShape(getPrompt(id).name).deco > 0) && lens[1] < 40 && lens[0] < 300) ids.forEach(id => { headers.set(id, Math.max(1, decoShape(getPrompt(id).name).deco)); twins.add(id); });
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
    const stack = [], wrapped = [];
    // 앞뒤를 같은 장식으로 감싼 이름(★…★): 장식 두 개
    const wrapOf = n => { const gs = graphemes(String(n || '').trim()); return gs.length > 2 && isDecoG(gs[0]) && isDecoG(gs.at(-1)) ? gs[0] + gs.at(-1) : ''; };
    const bare = n => String(n || '').replace(/[\u2934\u2935\uFE0F]/gu, '').trim();
    const pairKey = n => lettersOnly(bare(n).replace(/\b(?:start|begin|end)\b|시작|종료|끝|开始|结束|開始|終了/gi, ''));
    // 실리태번 기본 자리를 이름만 바꿔 끝 표시로 쓰는 프리셋도 있어서 짝은 목록 전체에서 찾음
    for (const id of order.map(e => e.identifier).filter(id => getPrompt(id))) {
        const n = String(getPrompt(id).name || ''), b = bare(n);
        const close = /\u2934/u.test(n) || /^<\/[A-Za-z][\w-]*\s*>$/.test(b) || /\bend\b|종료|끝|结束|終了/i.test(b);
        const open = !close && (/\u2935/u.test(n) || /^<[A-Za-z][\w-]*\b[^>]*>$/.test(b) || /\b(?:start|begin)\b|시작|开始|開始/i.test(b));
        if (open) { headers.depth.set(id, stack.length); stack.push(id); continue; }
        if (!close) { if (wrapOf(n) && !headers.has(id) && contentLen(getPrompt(id)) < 300) wrapped.push(id); continue; }
        let k = stack.length - 1;
        while (k >= 0 && pairKey(getPrompt(stack[k]).name) !== pairKey(n)) k--;
        if (k < 0 && stack.length && /\u2934/u.test(n) && /\u2935/u.test(getPrompt(stack[stack.length - 1]).name)) k = stack.length - 1;
        if (k >= 0) { headers.pairs.set(id, stack[k]); stack.splice(k); continue; }
        // 짝 말(시작)이 없는 끝 표시: 바로 위에서 같은 장식으로 감싼 항목이 시작 (★문체 고르기★ … ★문체 끝★)
        // (이미 구분선으로 보인 항목은 제 구역이 따로 있어서 빼고, 같은 말이 있는 것을 먼저)
        const w = wrapOf(n), same = x => wrapOf(getPrompt(x).name) === w;
        let m = w && contentLen(getPrompt(id)) < 40 ? wrapped.findLastIndex(x => same(x) && pairKey(getPrompt(x).name) === pairKey(n)) : -1;
        // 말이 달라도(★설정★ … ★세계 끝★) 바로 위의 것이면 짝 — 그 사이에 다른 구분선이 있으면 아님
        if (m < 0 && w && contentLen(getPrompt(id)) < 40) {
            m = wrapped.findLastIndex(same);
            const ids = order.map(e => e.identifier), from = m >= 0 ? ids.indexOf(wrapped[m]) : -1;
            if (m >= 0 && ids.slice(from + 1, ids.indexOf(id)).some(x => headers.has(x))) m = -1;
        }
        if (m >= 0) { headers.pairs.set(id, wrapped[m]); wrapped.splice(m); }
    }
    // 짝 표시(시작 · 끝)에 쓰인 장식으로 시작하는 짧은 항목도 구역 머리 (예: 「분위기🔻」 · 「분위기🔺」 짝이 있으면 「🔻 기본 규칙」도 머리)
    const marks = new Set([...twins, ...headers.pairs.keys(), ...headers.pairs.values()].flatMap(id => graphemes(String(getPrompt(id).name || '')).filter(isDecoG)));
    const leadOf = id => graphemes(String(getPrompt(id).name || '').trim())[0];
    const bullets = new Map();
    candidates.forEach(id => { if (!headers.has(id)) bullets.set(leadOf(id), (bullets.get(leadOf(id)) || 0) + 1); });
    candidates.forEach(id => {
        if (headers.has(id)) return;
        const p = getPrompt(id), sh = decoShape(p.name), lead = leadOf(id);
        if (marks.has(lead) && bullets.get(lead) <= 2 && sh.words > 0 && contentLen(p) < 120 && !END_WORD.test(bare(p.name))) headers.set(id, sh.deco);
    });
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
    while (i > 0 && ((i < x.length && glued(x[i - 1], x[i])) || (i < y.length && glued(y[i - 1], y[i])))) i--;
    return x.slice(0, i).join('');
}
const runName = p => { const t = balanced(p.replace(/\{\{[^}]*$/u, '').trim(), true); return t && balanced(t.replace(/^[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E\s]+/u, '').trim()); };
const strongName = n => graphemes(n).filter(isWordG).length >= 3;
const usefulName = n => graphemes(n).filter(isWordG).length >= 2 || (graphemes(n).length <= 2 && graphemes(n).some(g => /\p{Extended_Pictographic}/u.test(g)));

/** 낱말 단위 공통 끝부분 */
function commonSuffix(names) {
    const rev = n => graphemes(n).reverse();
    const xs = names.map(rev);
    if (!xs.length) return '';   // 빈 목록이면 아래 every 가 늘 참이라 끝나지 않음
    let i = 0;
    while (xs.every(x => i < x.length && x[i] === xs[0][i])) i++;
    while (i > 0 && xs.some(x => i < x.length && glued(x[i], x[i - 1]))) i--;
    return xs[0].slice(0, i).reverse().join('').trim();
}

/** 이모지만 남은 묶음 이름: 이름들의 공통 끝부분(감싼 괄호 벗김)을 붙임 */
function betterRunName(name, members, nameOf) {
    const words = graphemes(name).filter(isWordG).length;
    if (words >= 2) return name;
    let tail = commonSuffix(members.map(nameOf));
    const m = tail.match(/^[([{（【「](.*)[)\]}）】」]$/u);
    if (m) tail = m[1].trim();
    tail = balanced(tail, true);
    if (!tail || graphemes(tail).filter(isWordG).length < 2) return name;
    return words ? `${graphemes(name).filter(g => !isWordG(g)).join('').trim()} ${tail}`.trim() : `${name} ${tail}`;
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
        let pre = nameOf(ids[i]), j = i + 1, cut = null;
        for (; j < ids.length; j++) {
            if (ST_MARKERS.has(ids[j])) break;
            const next = commonPrefix(pre, nameOf(ids[j]));
            if (!usefulName(runName(next))) break;
            // 뚜렷한 머리말(낱말 2개 이상)로 2개 이상 묶였는데 이모지만 남게 되는 자리
            if (!cut && j - i >= 2 && strongName(runName(pre)) && !graphemes(runName(next)).some(isWordG)) cut = { j, pre };
            pre = next;
        }
        // 뒤에 남는 것이 따로 묶일 만큼(3개) 되면 그 자리에서 끊고, 아니면 이모지 하나로 다 같이 (⭐ 기본 A · ⭐ 기본 B · ⭐ 대화 · ⭐ 짧은 문단)
        if (cut && j - cut.j >= 3) ({ j, pre } = cut);
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
    const isEnd = id => END_WORD.test(nameOf(id));
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
        if (top && isEnd(id)) { top.members.push(id); top = sub = null; continue; }
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
        n.name = leads.length && leads.length <= 3 && !LEAD_EMOJI.test(n.name) ? `${leads.join('')} ${n.name}` : `${n.name} ${count}`;
    }
    return out;
}

/** 이름이 닮았는지: 낱말 단위 공통 앞부분 · 끝부분 · 이름표가 뚜렷하면 그 글자 수 (아니면 0) */
function kinScore(a, b) {
    const words = t => graphemes(t).filter(isWordG).length;
    const cj = graphemes(a).some(isCJ);
    const raw = commonPrefix(a, b).replace(/[\s([{（【「\-–—|｜:：·_/]+$/u, ''), pre = runName(raw), post = runName(commonSuffix([a, b])), key = labelKey(a);
    // 한자는 띄어쓰기가 없어서 앞부분 뒤에 끊는 자리(기호 · 숫자 · 끝 · 다른 글자)가 있어야 함 — 「设定|文风」 · 「设定|角色」처럼 두 글자만 같고 바로 글자가 이어지면 아님
    const n = graphemes(raw).length;
    const edge = t => { const g = graphemes(t)[n], q = graphemes(t)[n - 1]; return !g || !isWordG(g) || /\p{N}/u.test(g) || isCJ(g) !== isCJ(q ?? ''); };
    // 띄어 쓰는 말(영어 · 한국어)은 낱말 두 개 이상이 같아야 (Anti-… · …Style 같은 한 낱말은 흔해서 아님)
    const tokens = t => t.split(/[\s\-–—_/|｜:：·]+/u).filter(x => graphemes(x).some(isWordG)).length;
    const p = cj ? (words(pre) >= 2 && (edge(a) || edge(b)) ? words(pre) : 0) : (tokens(pre) >= 2 ? words(pre) : 0);
    const s = cj && words(post) >= 3 && post !== a && post !== b ? words(post) : 0;
    const k = key && key === labelKey(b) ? words(key) : 0;
    return Math.max(p, s, k);
}

/**
 * 「그룹 없는 토글만」: 남은 토글을 먼저 지금 그룹에 넣음 → { groups, into: Map(토글 → { group, why }), rest: [남은 토글] }
 * 토글마다 후보 그룹(앞 · 뒤 이웃 그룹, 이름이 닮은 토글의 그룹, 같은 구역 토글의 그룹)에 점수를 매겨 뚜렷이 앞서는 것만 넣음:
 * 앞 · 뒤 이웃, 이름 닮음, 이름 모양(「 」 · ! ! 같은 꾸밈) 같음, 자동 묶음 계획의 같은 구역. 넣은 것은 다음 토글의 이웃이 됨.
 */
function fitIntoGroups(order, groups, plan, nameOf, dividers = new Set(), W = {}) {
    const w = { near: 1.5, far: 1, head: 0.3, kin: 3, shape: 2, sub: 1.5, top: 0.5, need: 3, gap: 1, win: 3, pf: 3, tail: 1, ...W };
    const out = structuredClone(groups);
    const ids = order.map(e => e.identifier ?? e);
    const at = new Map(ids.map((id, i) => [id, i]));
    const home = new Map();
    out.forEach(g => g.members.forEach(id => { if (!home.has(id)) home.set(id, g); }));
    const into = new Map();
    const memo = f => { const m = new Map(); return id => (m.has(id) ? m.get(id) : (m.set(id, f(id)), m.get(id))); };
    // 이름 모양: 글자를 빼고 남은 꾸밈 (「 Lite 」 → 「」, ! 영어 ! → !!)
    const shapeOf = memo(id => graphemes(nameOf(id)).filter(g => !isWordG(g) && !/\s/u.test(g)).join(''));
    const subOf = new Map(), topOf = new Map();
    plan.forEach((n, i) => {
        [...n.members, ...(n.children || []).flatMap(c => c.members)].forEach(id => topOf.set(id, i));
        (n.children || []).forEach((c, j) => c.members.forEach(id => subOf.set(id, `${i}.${j}`)));
        n.members.forEach(id => { if (!subOf.has(id)) subOf.set(id, `${i}`); });
    });
    // 구역마다 토글 목록 (토글마다 목록 전체를 다시 훑지 않게)
    const listOf = (map) => { const m = new Map(); ids.forEach(y => { const k = map.get(y); if (k != null) { if (!m.has(k)) m.set(k, []); m.get(k).push(y); } }); return m; };
    const subIds = listOf(subOf), topIds = listOf(topOf);
    const grouped0 = ids.filter(id => home.has(id));
    const kinOf = memo(id => {
        if (dividers.has(id) || ST_MARKERS.has(id)) return null;
        let best = null;
        for (const y of grouped0) {
            const s = kinScore(nameOf(id), nameOf(y));
            if (!s) continue;
            const d = Math.abs(at.get(id) - at.get(y));
            if (!best || s > best.s || (s === best.s && d < best.d)) best = { s, d, g: home.get(y) };
        }
        return best?.g || null;
    });
    const scoreFor = id => {
        const i = at.get(id), score = new Map(), why = new Map();
        const add = (g, v, k) => { if (!g || !v) return; score.set(g, (score.get(g) || 0) + v); if (!why.has(g) || v >= 1.5) why.set(g, k); };
        let p = i - 1, q = i + 1;
        while (p >= 0 && !home.has(ids[p])) p--;
        while (q < ids.length && !home.has(ids[q])) q++;
        const P = p >= 0 ? home.get(ids[p]) : null, N = q < ids.length ? home.get(ids[q]) : null;
        // 이웃 그룹이 그 근처(앞 · 뒤 그룹 토글 몇 개)에서 대부분이 아니면(뜻으로 섞어 묶은 곳) 이웃 점수를 그만큼 낮춤
        // (앞 이웃은 앞쪽 그룹 토글 w.win 개, 뒤 이웃은 뒤쪽 w.win 개 가운데 그 그룹 비율)
        const side = (from, step) => { const got = []; for (let k = from; k >= 0 && k < ids.length && got.length < w.win; k += step) if (home.has(ids[k])) got.push(home.get(ids[k])); return got; };
        const purity = (g, got) => (got.length ? got.filter(x => x === g).length / got.length : 0);
        // 바로 뒤가 구분선이면 그건 다음 구역의 머리라 약하게
        if (P) add(P, (i - p <= 2 ? w.near : w.far) * Math.min(1, purity(P, side(p, -1)) * w.pf), 'near');
        if (N) add(N, (dividers.has(ids[q]) ? w.head : q - i <= 2 ? w.near : w.far) * Math.min(1, purity(N, side(q, 1)) * w.pf), 'near');
        // 구역 끝: 바로 뒤가 다음 구역 머리(구분선)이고 앞이 한 그룹으로 이어져 있으면 그 그룹의 끝에 붙은 토글
        if (P && N && P !== N && dividers.has(ids[q]) && !dividers.has(id) && i - p <= 2 && purity(P, side(p, -1)) >= 0.67) add(P, w.tail, 'near');
        add(kinOf(id), w.kin, 'name');
        const shape = shapeOf(id);
        const groupsSeen = new Set([P, N, kinOf(id)].filter(Boolean));
        const sub = subOf.get(id), top = topOf.get(id);
        const secCount = new Map(), secTotal = { sub: 0, top: 0 };
        const tally = (list, key) => {
            for (const y of list || []) {
                const g = home.get(y); if (!g || into.has(y)) continue;
                secTotal[key]++; groupsSeen.add(g);
                const c = secCount.get(g) || { sub: 0, top: 0 }; c[key]++; secCount.set(g, c);
            }
        };
        if (sub != null) tally(subIds.get(sub), 'sub');
        if (top != null) tally(topIds.get(top), 'top');
        for (const g of groupsSeen) {
            const c = secCount.get(g);
            if (c && secTotal.sub) add(g, w.sub * c.sub / secTotal.sub, 'section');
            if (c && secTotal.top) add(g, w.top * c.top / secTotal.top, 'section');
        }
        // 이름 모양은 후보 가운데 한 그룹만 그 모양일 때만 (모두 🔹… 이면 가르는 힘이 없음)
        if (shape) {
            const frac = [...groupsSeen].map(g => { const ms = g.members.filter(x => !into.has(x)); return [g, ms.length ? ms.filter(x => shapeOf(x) === shape).length / ms.length : 0]; });
            const hit = frac.filter(([, f]) => f >= 0.5);
            if (hit.length === 1) add(hit[0][0], w.shape * hit[0][1], 'shape');
        }
        const ranked = [...score].sort((a, b) => b[1] - a[1]);
        const [g, s] = ranked[0] || [];
        if (!g || s < w.need || (ranked[1] && s - ranked[1][1] < w.gap)) return null;
        return { g, why: why.get(g) };
    };
    for (let again = true; again;) {
        again = false;
        for (const id of ids) {
            if (home.has(id)) continue;
            const r = scoreFor(id);
            if (r) { r.g.members.push(id); home.set(id, r.g); into.set(id, { group: r.g.id, why: r.why }); again = true; }
        }
    }
    out.forEach(g => g.members.sort((x, y) => (at.get(x) ?? 1e9) - (at.get(y) ?? 1e9)));
    return { groups: out, into, rest: ids.filter(id => !home.has(id)) };
}

// AI 로 묶기: 토글 이름 · 내용 앞부분을 지금 연결된 API 로 한 번 보내 그룹 계획을 받음 (번호로 주고받아 이름이 바뀌어도 안전)
const AI_GROUP_PROMPT = `You organise the prompt toggles of a SillyTavern preset into folders so a user can find them quickly.
Input: one line per toggle — index | name. Only names are given, not the prompt text. Names may be decorated with symbols; markers like ⤵/⤴, start/end, <tag>/</tag> or blank names often open and close sections.
Return ONLY JSON: {"groups":[{"name":"","items":[0,1],"children":[{"name":"","items":[2,3]}]}]}
- Follow the preset's own sections when it has them; otherwise group by purpose (language, POV, style, pacing, NSFW, trackers, reasoning, jailbreak/system, etc.).
- Put "pick one" alternatives together. Keep a section's opening and closing marker in that section's group.
- Prefer neighbouring toggles; each index at most once; toggles that fit nowhere can stay out.
- At most two levels: 4 to 12 top-level groups, and inside a top-level group put children (sub-folders, at least 2 items each) when it holds two or more distinct sets — e.g. a style category with separate "pick one" sets. Never nest deeper than that.
- name: short Korean (2–12 characters) starting with one fitting emoji, e.g. "🌐 언어", "🎬 문체".`;

// 「그룹 없는 토글만」에서 기존 그룹을 같이 보낼 때 덧붙이는 지시
const AI_INTO_PROMPT = `
The preset already has groups. They come after the toggles, one line per group — G<number> | name | a few of its toggles (names only).
- First put a toggle into an existing group when it clearly belongs there: {"into":[{"group":"G3","items":[4,5]}]}.
- Make new groups (the "groups" list) only for toggles that fit no existing group. Don't make a new group that means the same as an existing one.
Return ONLY JSON: {"into":[...],"groups":[...]}`;

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
async function confirmAiSend(count, groupCount = 0) {
    if (settings().aiNoticeOk) return true;
    const e = escapeHtml, root = document.createElement('div');
    root.className = 'pf-ai-notice';
    root.innerHTML = `
        <h3>${e(tr`Before grouping with AI`)}</h3>
        <ul>
            <li><b>${e(tr`Sent`)}</b> — ${e(tr`the names of ${count} toggles and their order.`)}${groupCount ? ` ${e(tr`Also the names of your ${groupCount} groups, each with up to 3 of its toggle names, so toggles can go into them.`)}` : ''}</li>
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

/**
 * AI 묶음 계획. existing(기존 그룹)을 주면 그룹마다 이름 · 토글 이름 3개까지를 같이 보내 기존 그룹에 먼저 넣게 함
 * → plan 배열 (기존 그룹에 넣을 것은 plan.into: Map(토글 → 그룹 id))
 */
async function aiPlan(order, getPrompt, signal, existing = null) {
    const ids = order.map(x => x.identifier).filter(id => getPrompt(id));
    const lines = ids.map((id, i) => {
        // 프롬프트 내용 · 켜짐/꺼짐은 보내지 않음 (제작자 글 보호, 묶는 데 필요 없음) — 이름만
        return `${i} | ${String(getPrompt(id).name || '').trim() || '(no name)'}`;
    });
    // 기존 그룹: 토글이 바로 들어 있는 그룹만 (안에 그룹만 있는 큰 그룹은 넣을 곳이 아님)
    const known = (existing || []).filter(g => g.members?.length);
    const groupLines = known.map((g, i) => `G${i} | ${String(g.name || '').trim() || '(no name)'} | ${g.members.slice(0, 3).map(id => String(getPrompt(id)?.name ?? '').trim()).filter(Boolean).join(', ')}`);
    const prompt = known.length ? `${lines.join('\n')}\n\nExisting groups:\n${groupLines.join('\n')}` : lines.join('\n');
    const raw = await aiCall(known.length ? AI_GROUP_PROMPT + AI_INTO_PROMPT : AI_GROUP_PROMPT, prompt, signal);
    let rows, intoRows;
    try { const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); rows = j.groups; intoRows = j.into; } catch { throw new Error(tr`Couldn't read the AI answer. Try again.`); }
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
    plan.sort((a, b) => first(a) - first(b));
    // 기존 그룹에 넣기: 새 그룹에 이미 쓴 번호는 빼고 (한 토글은 한 곳만)
    plan.into = new Map();
    for (const r of Array.isArray(intoRows) ? intoRows : []) {
        const g = known[Number(String(r?.group ?? '').replace(/^G/i, ''))];
        if (g) take(r?.items).forEach(id => plan.into.set(id, g.id));
    }
    return plan;
}

/** 자동 그룹: 계획을 그룹 편집기에 채워 보여 줌 (고친 뒤 만들기) */
async function autoGroup() {
    return openGroupEditor({ auto: true });
}

/** 이 프리셋의 그룹을 모두 풀기 (토글은 그대로) — 알림에서 되돌리기 */
async function ungroupAll() {
    const data = presetData();
    if (!data.groups.length) return;
    const ok = await callGenericPopup(escapeHtml(tr`Ungroup all ${data.groups.length} groups of this preset? The toggles themselves are not changed.`), POPUP_TYPE.CONFIRM);
    if (!ok) return;
    const snap = takeSnap();
    data.groups = [];
    save();
    apply();
    offerRestore(snap, tr`All groups were ungrouped.`);
}

// ---------- 그룹 옮기기 (파일 · 다른 프리셋, 프리셋 새 버전으로) ----------
const nfcName = s => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

/**
 * 다른 곳의 그룹을 지금 프리셋에 맞춤. 토글은 ① 같은 id ② id 가 없으면 같은 이름(새 버전에서 다시 만든 토글)으로 찾고, 못 찾으면 뺌.
 * 새 버전에만 있는 토글은 실제 순서에서 바로 앞 · 뒤 토글이 같은 그룹이면 그 그룹에 넣음. 택1 · 색 · 접힘 · 그룹 안 그룹은 그대로.
 */
function remapGroups(groups, srcNames = {}) {
    const pm = promptManager;
    const prompts = pm?.serviceSettings?.prompts || [];
    const known = new Set(prompts.map(p => p.identifier));
    const byName = new Map();
    prompts.forEach(p => { const n = nfcName(p.name); if (n) byName.set(n, byName.has(n) ? null : p.identifier); });   // 같은 이름이 둘이면 이름으로는 안 맞춤
    const stats = { kept: 0, byName: 0, missing: 0, placed: 0 };
    const how = {};   // 토글 id → 'name'(이름으로 맞춤) · 'placed'(새 토글을 옆 그룹에)
    const taken = new Set();
    const out = structuredClone(groups).map(g => {
        const members = [];
        for (const id of g.members || []) {
            let to = known.has(id) ? id : null;
            if (to) stats.kept++;
            else { const hit = byName.get(nfcName(srcNames[id])); if (hit) { to = hit; how[hit] = 'name'; stats.byName++; } else stats.missing++; }
            if (to && !taken.has(to)) { taken.add(to); members.push(to); }
        }
        return { id: g.id || newId(), name: String(g.name ?? ''), members, parent: g.parent || null, collapsed: !!g.collapsed, ...(g.color ? { color: g.color } : {}), ...(Number.isInteger(g.slot) ? { slot: g.slot } : {}), ...(g.exclusive ? { exclusive: true } : {}) };
    });
    // 새 토글: 앞 · 뒤가 같은 그룹이면 그 안으로
    const order = (pm?.getPromptOrderForCharacter(pm.activeCharacter) || []).map(e => e.identifier).filter(id => known.has(id));
    const groupOf = id => out.find(g => g.members.includes(id));
    order.forEach((id, i) => {
        if (taken.has(id)) return;
        let p = i - 1, n = i + 1;
        while (p >= 0 && !taken.has(order[p])) p--;
        while (n < order.length && !taken.has(order[n])) n++;
        const gp = p >= 0 ? groupOf(order[p]) : null, gn = n < order.length ? groupOf(order[n]) : null;
        if (gp && gp === gn) { gp.members.push(id); taken.add(id); how[id] = 'placed'; stats.placed++; }
    });
    const at = new Map(order.map((id, i) => [id, i]));
    out.forEach(g => g.members.sort((x, y) => (at.get(x) ?? 1e9) - (at.get(y) ?? 1e9)));
    // 토글도 하위 그룹도 없는 그룹은 뺌
    const tree = makeTree(out);
    const kept = out.filter(g => tree.allItems(g).length);
    stats.free = order.filter(id => !taken.has(id)).length;
    return { groups: kept, stats, how };
}

/** 맞춘 결과: 몇 개 그대로 · 이름으로 맞춤 · 없음 · 새 토글 넣음 */
const remapStats = r => tr`${r.stats.kept} toggles matched · ${r.stats.byName} matched by name · ${r.stats.missing} not in this preset · ${r.stats.placed} new toggles placed next to their neighbors · ${r.stats.free} left outside groups`;

function exportGroups() {
    // 토글 이름도 같이 — 프리셋 새 버전에서 id 가 바뀌어도 이름으로 찾게
    const names = Object.fromEntries((promptManager?.serviceSettings?.prompts || []).map(p => [p.identifier, p.name || '']));
    const data = { type: 'prompt-folders', version: 2, preset: presetKey(), groups: presetData().groups, names };
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
        let json;
        try {
            json = JSON.parse(await getFileText(file));
            const groups = Array.isArray(json) ? json : json?.groups;
            if (!Array.isArray(groups) || !groups.every(g => g && typeof g.name === 'string' && Array.isArray(g.members))) throw new Error('not a groups file');
            await openGroupEditor({ sources: [{ key: json.preset || file.name, label: json.preset || file.name, load: () => ({ groups, names: json.names || {} }) }] });
        } catch (err) {
            console.warn('[Prompt Folders] import failed', err);
            toastr.error(tr`This file is not a Prompt Folders export.`, tr`Prompt Folders`);
        }
    });
    input.click();
}

/** 다른 프리셋(예: 예전 버전)의 그룹을 지금 프리셋으로 — 이름이 비슷한 프리셋이 먼저 */
async function importFromPreset() {
    const here = presetKey();
    const stem = s => nfcName(s).toLowerCase().replace(/[\s_\-.]*v?\d+(?:\.\d+)*\s*$/i, '').replace(/[\d.]+/g, '').trim();
    const list = Object.entries(settings().presets).filter(([k, v]) => nfcName(k) !== nfcName(here) && v?.groups?.length)
        .map(([k, v]) => ({ k, n: v.groups.length, near: stem(k) && stem(k) === stem(here) }))
        .sort((a, b) => (b.near - a.near) || (a.near ? b.k.localeCompare(a.k, undefined, { numeric: true }) : a.k.localeCompare(b.k)));   // 같은 이름 프리셋은 최신 버전 먼저
    if (!list.length) return toastr.info(tr`No other preset has groups yet.`, tr`Prompt Folders`);
    const namesOf = from => { try { return Object.fromEntries((getPresetManager('openai')?.getCompletionPresetByName(from)?.prompts || []).map(p => [p.identifier, p.name || ''])); } catch { return {}; } };   // 없으면 id 로만
    await openGroupEditor({ sources: list.map(x => ({ key: x.k, label: `${x.k} — ${tr`${x.n} groups`}`, near: x.near, load: () => ({ groups: settings().presets[x.k].groups, names: namesOf(x.k) }) })) });
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
    if (changed) commitToggles();
    return changed;
}

function setupExclusive() {
    if (window.__pfExclusiveHooked) return;
    window.__pfExclusiveHooked = true;
    // 프롬프트 목록의 토글 단추(원래 줄 · 그룹 안 복사본): 실리태번 처리(토큰 세기 → 목록 전체 다시 그리기)를 거치지 않고 바로 바꿈
    document.addEventListener('click', e => {
        const btn = e.target.closest?.('.prompt-manager-toggle-action');
        if (!btn || !btn.closest(`#${LIST_ID}`)) return;
        const row = btn.closest('li');
        const id = row?.dataset.pmIdentifier || row?.dataset.pfId;
        const pm = promptManager;
        const prompt = id && pm?.getPromptById(id);
        const entry = prompt && pm.activeCharacter && pm.getPromptOrderEntry(pm.activeCharacter, id);
        if (!entry || !pm.isPromptToggleAllowed(prompt)) return;   // 모르는 줄은 실리태번에 맡김
        e.preventDefault();
        e.stopPropagation();
        if (suppressClick) return;   // 끌기를 막 끝낸 클릭
        const snap = takeSnap();
        entry.enabled = !entry.enabled;
        commitToggles([id]);
        // 택1 그룹: 켠 토글 말고 같은 그룹의 다른 토글은 끔
        if (entry.enabled) { const off = enforceExclusive(new Set(), id); if (off) offerRestore(snap, tr`Pick-one group: turned off ${off} other toggles.`); }
    }, true);
}

function setExclusive(g, on) {
    const snap = takeSnap();   // 되돌리기용
    const pm = promptManager;
    const order = pm?.getPromptOrderForCharacter(pm.activeCharacter) || [];
    const items = new Set(makeTree(presetData().groups).allItems(g));
    g.exclusive = on || undefined;
    if (!g.exclusive) delete g.exclusive;
    save();
    let off = 0;
    if (on) {
        // 이미 여러 개가 켜져 있으면 실제 순서에서 첫 번째만 남김
        const first = order.find(e => e.enabled && items.has(e.identifier));
        if (first) off = enforceExclusive(new Set(), first.identifier);
    }
    apply();
    const msg = on ? (off ? tr`"${g.name}" is now pick-one. Turned off ${off} other toggles.` : tr`"${g.name}" is now pick-one.`) : tr`"${g.name}" is no longer pick-one.`;
    if (off) offerRestore(snap, msg);   // 다른 토글을 껐을 때만(그 밖엔 「택1」을 다시 누르면 됨)
    else toastr.success(escapeHtml(msg), tr`Prompt Folders`);
}

// ---------------- 되돌리기 ----------------
/** 되돌리기용 상태: 이 프리셋의 실제 프롬프트 순서 · 켜짐 + 그룹 */
function takeSnap() {
    const pm = promptManager;
    const order = pm?.activeCharacter ? (pm.getPromptOrderForCharacter(pm.activeCharacter) || []).map(e => ({ ...e })) : null;
    return { key: presetKey(), order, groups: structuredClone(presetData().groups) };
}

function restoreSnap(snap) {
    if (presetKey() !== snap.key) return toastr.warning(tr`The preset has changed, so this can't be undone.`, tr`Prompt Folders`);
    const pm = promptManager;
    // 켬/끔만 바뀐 경우(그룹 스위치 · 택1 · 토글)는 토글 누를 때와 같은 길로 그 자리에서만 되돌림 — 목록 전체를 다시 그리면 되돌리기가 스위치를 다시 누르는 것보다 느렸음
    const cur = pm?.activeCharacter ? pm.getPromptOrderForCharacter(pm.activeCharacter) || [] : [];
    if (snap.order && cur.length === snap.order.length && cur.every((x, i) => x.identifier === snap.order[i].identifier)
        && JSON.stringify(snap.groups) === JSON.stringify(presetData().groups)) {
        const changed = [];
        cur.forEach((x, i) => { const want = !!snap.order[i].enabled; if (!!x.enabled !== want) { x.enabled = want; changed.push(x.identifier); } });
        if (changed.length) commitToggles(changed);
        toastr.info(tr`Undone.`, tr`Prompt Folders`);
        return;
    }
    if (snap.order && pm?.activeCharacter) {
        pm.removePromptOrderForCharacter(pm.activeCharacter);
        pm.addPromptOrderForCharacter(pm.activeCharacter, snap.order.map(e => ({ ...e })));
        pm.saveServiceSettings();
    }
    settings().presets[snap.key] = { ...(settings().presets[snap.key] || {}), groups: structuredClone(snap.groups) };
    save();
    pm?.render?.();
    apply();
    toastr.info(tr`Undone.`, tr`Prompt Folders`);
}

/** 바꾼 뒤 알림 — 누르면 snap 으로 되돌림 */
function offerRestore(snap, message) {
    // 알림 띄우기가 테마 · 확장에 따라 0.1~0.3초 걸려서, 바뀐 화면을 먼저 그린 다음에 띄움
    const show = () => toastr.success(`${escapeHtml(message)} <u>${escapeHtml(tr`Undo`)}</u>`, tr`Prompt Folders`, {
        escapeHtml: false, timeOut: 10000, extendedTimeOut: 4000,
        onclick: () => restoreSnap(snap),
    });
    // (화면을 안 그리는 때 — 숨긴 탭 등 — 에도 뜨게 0.2초 뒤 한 번 더 시도, 알림은 한 번만)
    let shown = false;
    const once = () => { if (!shown) { shown = true; show(); } };
    requestAnimationFrame(() => setTimeout(once, 0));
    setTimeout(once, 200);
}

function setAllCollapsed(collapsed) {
    const groups = presetData().groups;
    groups.forEach(g => { g.collapsed = collapsed; });
    rememberFolds(groups);
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
    commitToggles();
}

function createGroup(parentId = null) {
    return openGroupEditor({ addNew: true, newParent: parentId });
}

// 「이 그룹 편집」: 큰 그룹 편집기를 그 그룹(과 안의 그룹)만 보이게 줄여서 — 생김새 · 다루는 법이 같음
function startEditing(g) {
    return openGroupEditor({ focusId: g.id, scopeId: g.id });
}


/** 이름 앞의 이모지 · 기호(국기 · 변형 선택자 · ZWJ 포함)와 그 뒤 공백을 뗌 — 다 떼면 비는 이름은 그대로 */
function plainName(name) {
    const out = String(name || '').replace(/^(?:[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}][\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]*)+\s*/u, '').trim();
    return out || String(name || '');
}

/**
 * 자동 그룹 계획(큰 그룹 → 작은 그룹, 최대 2단) → 편집기 초안 { groups, into }.
 * free 면 지금 그룹은 두고 그룹 없는 토글만 — 먼저 지금 그룹에 넣을 수 있는 것은 넣고(into: 토글 → 그룹 id) 남은 것만 새 그룹으로.
 * aiInto 가 있으면(AI 가 고른 기존 그룹) 그대로 씀
 */
function planToDraft(plan, mode, existing, nameOf, { order = [], dividers, aiInto = null } = {}) {
    let base = [], into = new Map();
    if (mode === 'free' && aiInto) {
        base = structuredClone(existing);
        const taken = new Set(base.flatMap(g => g.members));
        aiInto.forEach((gid, id) => { const g = base.find(x => x.id === gid); if (g && !taken.has(id)) { g.members.push(id); taken.add(id); into.set(id, { group: gid, why: 'ai' }); } });
        const at = new Map(order.map((e, i) => [e.identifier ?? e, i]));
        base.forEach(g => g.members.sort((x, y) => (at.get(x) ?? 1e9) - (at.get(y) ?? 1e9)));
    } else if (mode === 'free') ({ groups: base, into } = fitIntoGroups(order, existing, plan, nameOf, dividers));
    const taken = new Set(base.flatMap(g => g.members));
    const free = ids => ids.filter(id => !taken.has(id));
    const nameFor = (n, ids) => (n.name || '').trim() || String(nameOf(ids[1] ?? ids[0] ?? '') || '').trim() || tr`Group ${base.length + 1}`;
    // 「그룹 없는 토글만」: 남은 토글이 1개뿐인 새 그룹 · 하위 그룹은 만들지 않음 (그 토글은 그룹 밖에 둠)
    const least = mode === 'free' ? 2 : 1;
    for (const n of plan) {
        const kidsIn = (n.children || []).map(c => ({ c, members: [...new Set(free(c.members))] })).filter(k => k.members.length >= least);
        const kidIds = new Set(kidsIn.flatMap(k => k.members));
        const topMembers = [...new Set(free(n.members))].filter(id => !kidIds.has(id));
        if (topMembers.length + kidIds.size < Math.max(least, 1)) continue;
        if (!topMembers.length && !kidsIn.length) continue;
        // 「그룹 없는 토글만」에서 큰 그룹에 남은 게 거의 없고 하위가 하나뿐이면 2단으로 만들지 않고 한 그룹으로
        if (mode === 'free' && topMembers.length <= 1 && kidsIn.length === 1) {
            const ids = [...topMembers, ...kidsIn[0].members].sort((x, y) => order.findIndex(e => (e.identifier ?? e) === x) - order.findIndex(e => (e.identifier ?? e) === y));
            ids.forEach(id => taken.add(id));
            base.push({ id: newId(), name: nameFor(n, ids), members: ids, parent: null, collapsed: true, ...(n.exclusive ? { exclusive: true } : {}) });
            continue;
        }
        [...topMembers, ...kidIds].forEach(id => taken.add(id));
        const top = { id: newId(), name: '', members: topMembers, parent: null, collapsed: true, ...(n.exclusive ? { exclusive: true } : {}) };
        const kids = kidsIn.map(k => ({ id: newId(), name: plainName(nameFor(k.c, k.members)), members: k.members, parent: top.id, collapsed: true, ...(k.c.exclusive ? { exclusive: true } : {}) }));   // 2단계 폴더 이름엔 앞 이모지 없이
        top.name = nameFor(n, top.members.length ? top.members : kids[0].members);
        base.push(top, ...kids);
    }
    return { groups: base, into };
}

/**
 * 그룹 편집기 (한 창): 왼쪽 그룹 목록(최대 2단 — 이름 고치기 · 하위 그룹 · 택1 · 지우기), 오른쪽 토글 목록(여러 개 골라 한 번에 넣기 · 빼기).
 * 그룹 만들기 · 그룹 편집 · 안에 새 그룹 · 자동으로 그룹 만들기가 모두 이 창을 씀. 저장(만들기)을 눌러야 반영, 반영 뒤 알림에서 되돌리기.
 */
/** 편집기 높이를 창 안에 들어오게 줄임 — 확인 · 취소 단추가 창 몸통(.popup-body, 테마가 넘치면 숨김으로 둠) · 창 · 화면 아래 끝 안에 있게 */
function fitEditorHeight(root) {
    const popup = root.closest('.popup');
    const body = popup?.querySelector('.popup-body');
    const controls = popup?.querySelector('.popup-controls');
    if (!popup || !controls) return;
    root.style.height = '';
    const bottomOf = (el) => { const cs = getComputedStyle(el); return el.getBoundingClientRect().bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom); };
    for (let i = 0; i < 3; i++) {   // 줄이면 창도 같이 줄 수 있어 몇 번 다시 잼
        const limit = Math.min(bottomOf(popup), body ? bottomOf(body) : Infinity, window.innerHeight - 6);
        const over = controls.getBoundingClientRect().bottom - limit;
        if (over <= 0.5) break;
        root.style.height = Math.max(200, root.offsetHeight - over - 4) + 'px';
    }
}

async function openGroupEditor({ focusId = null, addNew = false, newParent = null, auto = false, sources = null, scopeId = null } = {}) {
    const pm = promptManager;
    if (!pm?.activeCharacter) return;
    const data = presetData();
    const rawOrder = pm.getPromptOrderForCharacter(pm.activeCharacter) || [];
    const getPrompt = id => pm.getPromptById(id);
    const hdr = findHeaders(rawOrder, getPrompt);
    const order = rawOrder.filter(x => getPrompt(x.identifier)).map((x, i) => ({ id: x.identifier, pos: i + 1, name: String(getPrompt(x.identifier)?.name ?? x.identifier), on: !!x.enabled, divider: hdr.has(x.identifier) }));
    const at = new Map(order.map((x, i) => [x.id, i]));
    const nameOf = id => order[at.get(id)]?.name ?? id;
    const e = escapeHtml;

    let plan = auto ? planAutoGroups(rawOrder, getPrompt) : [];
    let mode = data.groups.length ? 'free' : 'all';
    // 가져오기: 고른 곳의 그룹을 이 프리셋에 맞춘 결과로 시작 — 어떻게 맞췄는지 토글마다 표시
    const imp = sources?.length ? sources : null;
    let impSrc = imp?.[0], impRes = null;
    // 같은 프리셋의 다른 버전(이름에서 버전 숫자만 다름)을 따로 묶어 위에
    const impOptions = () => {
        const opt = x => `<option value="${imp.indexOf(x)}">${e(x.label)}</option>`;
        const near = imp.filter(x => x.near), rest = imp.filter(x => !x.near);
        if (!near.length || !rest.length) return imp.map(opt).join('');
        const head = t => `<option disabled>── ${e(t)} ──</option>`;   // optgroup 은 브라우저마다 글꼴이 달라서 보통 줄로
        return head(tr`Other versions of this preset`) + near.map(opt).join('') + head(tr`Other presets`) + rest.map(opt).join('');
    };
    const runImport = () => { const s = impSrc.load(); impRes = remapGroups(s.groups, s.names); return impRes.groups; };
    // 자동 그룹 초안: 「그룹 없는 토글만」이면 남은 토글을 먼저 기존 그룹에 (fitInto: 토글 → { group, why })
    const liveOrder = rawOrder.filter(x => getPrompt(x.identifier));
    let fitInto = new Map();
    const autoDraft = () => { const r = planToDraft(plan, mode, data.groups, nameOf, { order: liveOrder, dividers: new Set(hdr.keys()), aiInto: plan.into || null }); fitInto = r.into; return r.groups; };
    let draft = imp ? runImport() : auto ? autoDraft() : structuredClone(data.groups);
    // 이번에 바뀐 것 표시용: 원래 어느 그룹에 있었는지
    const origOf = new Map();
    data.groups.forEach(g => g.members.forEach(id => { if (!origOf.has(id)) origOf.set(id, g.id); }));
    const isOld = g => data.groups.some(x => x.id === g.id);
    // (「전부 새로」에선 모두 새 것이라 표시하지 않음 — 「그룹 없는 토글만」일 때만)
    const movedHere = id => auto && mode === 'free' && (groupOf(id)?.id ?? null) !== (origOf.get(id) ?? null) && !!groupOf(id);
    let sel = focusId;   // 고른 그룹 (토글을 넣을 곳)
    const addGroup = parent => { const g = { id: newId(), name: '', members: [], parent, collapsed: false }; draft.push(g); sel = g.id; return g; };
    if (addNew) addGroup(newParent);
    const selected = new Set();   // 고른 토글
    const custom = new Set();   // 안에서 순서를 직접 바꾼 그룹 id

    const root = document.createElement('div');
    root.className = 'pf-editor pf-be' + (scopeId ? ' pf-be-scope' : '');
    root.innerHTML = `
        <h3 class="pf-ed-title">${e(imp ? tr`Bring groups from another preset` : auto ? tr`Auto-group` : scopeId ? tr`Edit this group` : tr`Edit groups`)}</h3>
        <div class="pf-ed-summary"></div>
        ${imp ? `${imp.length > 1 ? `<select class="text_pole pf-imp-from" aria-label="${e(tr`Bring from`)}">${impOptions()}</select>` : ''}
        <div class="pf-imp-stats"></div>` : ''}
        ${auto ? `<div class="pf-auto-ai"><button type="button" class="menu_button pf-auto-ai-run"><i class="fa-solid fa-wand-magic-sparkles"></i><span>${e(tr`Regroup with AI`)}</span></button><small class="pf-auto-ai-note">${e(tr`Sends only the toggle names (not their text) once to the chosen connection.`)}</small>${aiPickersHtml()}</div>
        <div class="pf-ed-filter pf-be-mode" role="radiogroup">
            <button type="button" class="pf-ed-chip" data-m="free" role="radio">${e(tr`Only toggles not in a group`)}</button>
            <button type="button" class="pf-ed-chip" data-m="all" role="radio">${e(tr`Regroup everything`)}</button>
        </div>` : ''}
        <div class="pf-be-panes">
            <section class="pf-be-groups">
                <div class="pf-be-head"><b>${e(tr`Groups`)}</b><button type="button" class="pf-tb pf-be-add"><i class="fa-solid fa-plus"></i> ${e(tr`New group`)}</button></div>
                <ul class="pf-be-tree" role="listbox" aria-label="${e(tr`Groups`)}"></ul>
            </section>
            <section class="pf-be-items">
                <div class="pf-ed-bar">
                    <label class="pf-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" placeholder="${e(tr`Search toggles`)}" aria-label="${e(tr`Search toggles`)}"></label>
                </div>
                <div class="pf-ed-filter pf-be-filter" role="radiogroup">
                    <button type="button" class="pf-ed-chip" data-f="all" role="radio">${e(tr`All`)}</button>
                    <button type="button" class="pf-ed-chip" data-f="mine" role="radio">${e(tr`Picked group`)}</button>
                    <button type="button" class="pf-ed-chip" data-f="free" role="radio">${e(tr`Not in a group`)}</button>
                    ${auto ? `<button type="button" class="pf-ed-chip" data-f="changed" role="radio">${e(tr`Changed this time`)}</button>` : ''}
                </div>
                <div class="pf-be-actions">
                    <span class="pf-be-hint">${e(matchMedia('(pointer: coarse)').matches ? tr`Pick many: long-press, then drag` : tr`Pick many: drag · Shift+click for a range`)}</span>
                    <span class="pf-ed-count"></span>
                    <button type="button" class="menu_button pf-be-put"></button>
                    <button type="button" class="menu_button pf-be-out">${e(tr`Remove from group`)}</button>
                    <button type="button" class="pf-tb pf-be-clear">${e(tr`Clear`)}</button>
                </div>
                <ul class="pf-ed-list" role="listbox" aria-multiselectable="true"></ul>
            </section>
        </div>`;
    const treeEl = root.querySelector('.pf-be-tree'), list = root.querySelector('.pf-ed-list');
    const count = root.querySelector('.pf-ed-count'), putBtn = root.querySelector('.pf-be-put'), outBtn = root.querySelector('.pf-be-out');
    const summary = root.querySelector('.pf-ed-summary');
    const setSummary = text => { summary.textContent = text; };
    // 기존 그룹에 넣은 것 · 새 그룹 수 안내
    const intoNote = () => { const fresh = draft.filter(g => !isOld(g)).length; return tr`${fitInto.size} leftover toggles go into existing groups and ${fresh} new groups are made. Changes are marked New — pick "Changed this time" to see only them. Fix anything, then create.`; };
    const ungroupedCount = () => { const g = new Set(data.groups.flatMap(x => x.members)); return order.filter(x => !g.has(x.id)).length; };
    const noneLeft = () => auto && mode === 'free' && !ungroupedCount();
    setSummary(imp ? tr`Toggles are matched by the same id first, then by the same name. A toggle new in this preset joins a group when the toggles before and after it are in that group. Fix anything here, then bring. The current groups of this preset are replaced.` : noneLeft() ? tr`Every toggle is already in a group, so there is nothing to group. Pick "Regroup everything" to start over.` : auto ? (mode === 'free' && fitInto.size ? intoNote() : plan.length ? tr`Grouped by divider toggles and similar names. Fix names, move toggles, then create.` : tr`Couldn't find anything to group automatically in this preset. Try regrouping with AI.`) : tr`Pick a group on the left, pick toggles on the right, then put them in. Up to two levels.`);

    const tree = () => makeTree(draft);
    const groupOf = id => draft.find(g => g.members.includes(id)) || null;
    const depthOf = g => (tree().parentOf(g) ? 1 : 0);
    const firstAt = g => Math.min(1e9, ...tree().allItems(g).map(id => at.get(id) ?? 1e9));
    // 그룹 순서: 처음엔 그룹 안 토글의 실제 위치 순 — 끌거나 위아래 단추로 바꾸면 그때부터 draft 배열 순서를 따름
    let reordered = isCustomLayout();   // 「내가 정한 순서」 배치는 처음부터 배열 순서
    const bySpot = (a, b) => reordered ? draft.indexOf(a) - draft.indexOf(b) : (firstAt(a) - firstAt(b) || draft.indexOf(a) - draft.indexOf(b));
    const sibsOf = g => { const t = tree(), p = t.parentOf(g); return draft.filter(x => t.parentOf(x) === p).sort(bySpot); };
    // 처음 순서를 바꿀 때: 지금 보이는 차례대로 draft 를 다시 늘어놓음 (그 뒤로는 배열 순서 = 보이는 순서)
    const freeze = () => {
        if (reordered) return;
        const t = tree(), out = [];
        const walk = g => { out.push(g); t.childrenOf(g).sort(bySpot).forEach(walk); };
        draft.filter(g => !t.parentOf(g)).sort(bySpot).forEach(walk);
        draft.forEach(g => { if (!out.includes(g)) out.push(g); });
        draft = out;
        reordered = true;
    };
    // g 를 같은 단계의 ref 앞(또는 뒤)으로
    const placeGroup = (g, ref, after) => {
        if (!g || !ref || g === ref) return;
        freeze();
        draft = draft.filter(x => x !== g);
        const i = draft.indexOf(ref);
        draft.splice(after ? i + 1 : i, 0, g);
        renderTree();
    };
    const stepDraft = (g, dir) => {
        const sibs = sibsOf(g), i = sibs.indexOf(g), j = i + dir;
        if (j < 0 || j >= sibs.length) return void toastr.info(dir < 0 ? tr`Already at the top.` : tr`Already at the bottom.`, tr`Prompt Folders`);
        placeGroup(g, sibs[j], dir > 0);
    };
    const colorOf = g => { const t = tree(); return groupColor(g, t.indexOf(g), t); };

    function renderTree() {
        const t = tree();
        const scopeRoot = scopeId ? draft.find(x => x.id === scopeId) : null;
        const tops = scopeRoot ? [scopeRoot] : draft.filter(g => !t.parentOf(g)).sort(bySpot);
        // 직접 편집은 단계 제한 없음 — 깊이만큼 들여 씀
        const row = (g, depth) => {
            const n = t.allItems(g).length, top = !depth;
            return `<li class="pf-be-g${sel === g.id ? ' pf-be-sel' : ''}${top ? '' : ' pf-be-sub'}" data-g="${e(g.id)}" role="option" aria-selected="${sel === g.id}" style="--pf-color:${colorOf(g)};--pf-depth:${depth}">
                <span class="pf-be-grip" title="${e(tr`Drag to reorder`)}"><i class="fa-solid fa-grip-lines"></i></span>
                <span class="pf-be-dot"></span>
                <input type="text" class="text_pole pf-be-name" value="${e(g.name)}" placeholder="${e(tr`Group name`)}" aria-label="${e(tr`Group name`)}">
                <span class="pf-be-n">${auto && mode === 'free' ? (isOld(g) ? (() => { const k = g.members.filter(id => origOf.get(id) !== g.id).length; return k ? `<span class="pf-new-badge" title="${e(tr`Toggles added to this group this time`)}">+${k}</span>` : ''; })() : `<span class="pf-new-badge pf-new-word" title="${e(tr`A group made this time`)}">${e(tr`New`)}</span>`) : ''}${n}</span>
                ${scopeRoot && g === scopeRoot ? '<span class="pf-be-mv"></span>' : `<span class="pf-be-mv"><button type="button" class="pf-be-ic" data-act="up" title="${e(tr`Move group up`)}" aria-label="${e(tr`Move group up`)}"><i class="fa-solid fa-chevron-up"></i></button><button type="button" class="pf-be-ic" data-act="down" title="${e(tr`Move group down`)}" aria-label="${e(tr`Move group down`)}"><i class="fa-solid fa-chevron-down"></i></button></span>`}
                <button type="button" class="pf-be-ic" data-act="sub" title="${e(tr`New group inside`)}" aria-label="${e(tr`New group inside`)}"><i class="fa-solid fa-folder-plus"></i></button>
                <button type="button" class="pf-be-ic${g.exclusive ? ' on' : ''}" data-act="excl" title="${e(tr`Only one on`)}" aria-pressed="${!!g.exclusive}" aria-label="${e(tr`Only one on`)}">${e(tr`Pick 1`)}</button>
                <button type="button" class="pf-be-ic" data-act="del" title="${e(tr`Ungroup`)}" aria-label="${e(tr`Ungroup`)}"><i class="fa-solid fa-xmark"></i></button>
            </li>`;
        };
        const free = order.filter(x => !groupOf(x.id)).length;
        const branch = (g, depth, seen = new Set()) => seen.has(g) ? '' : (seen.add(g), row(g, depth) + t.childrenOf(g).sort(bySpot).map(k => branch(k, depth + 1, seen)).join(''));
        treeEl.innerHTML = tops.map(g => branch(g, 0)).join('')
            + `<li class="pf-be-g pf-be-none${sel === '' ? ' pf-be-sel' : ''}" data-g="" role="option" aria-selected="${sel === ''}"><span class="pf-be-grip pf-be-grip-none"></span><span class="pf-be-dot"></span><span class="pf-be-label">${e(tr`Not in a group`)}</span><span class="pf-be-n">${free}</span></li>`;
        if (!draft.length) treeEl.insertAdjacentHTML('afterbegin', `<li class="pf-be-empty">${e(tr`No groups yet. Add one with + New group.`)}</li>`);
        updateActions();
    }
    // 그룹 끌기: ☰ 손잡이를 잡고 같은 단계의 다른 그룹 위 · 아래로 (마우스 · 터치)
    let gDrag = null;
    treeEl.addEventListener('pointerdown', ev => {
        const grip = ev.target.closest('.pf-be-grip'); if (!grip || grip.classList.contains('pf-be-grip-none')) return;
        const li = grip.closest('[data-g]'); const g = draft.find(x => x.id === li?.dataset.g); if (!g) return;
        ev.preventDefault();
        grip.setPointerCapture?.(ev.pointerId);
        gDrag = { g, li, target: null, after: false };
        li.classList.add('pf-be-dragging');
    });
    treeEl.addEventListener('pointermove', ev => {
        if (!gDrag) return;
        treeEl.querySelectorAll('.pf-be-drop-before, .pf-be-drop-after').forEach(x => x.classList.remove('pf-be-drop-before', 'pf-be-drop-after'));
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.pf-be-g[data-g]');
        const sibs = sibsOf(gDrag.g);
        const t = over && draft.find(x => x.id === over.dataset.g);
        gDrag.target = t && t !== gDrag.g && sibs.includes(t) ? t : null;
        if (!gDrag.target) return;
        const r = over.getBoundingClientRect();
        gDrag.after = ev.clientY > r.top + r.height / 2;
        over.classList.add(gDrag.after ? 'pf-be-drop-after' : 'pf-be-drop-before');
    });
    const endGDrag = () => {
        if (!gDrag) return;
        const { g, target, after, li } = gDrag;
        gDrag = null;
        li.classList.remove('pf-be-dragging');
        treeEl.querySelectorAll('.pf-be-drop-before, .pf-be-drop-after').forEach(x => x.classList.remove('pf-be-drop-before', 'pf-be-drop-after'));
        if (target) placeGroup(g, target, after);
    };
    treeEl.addEventListener('pointerup', endGDrag);
    treeEl.addEventListener('pointercancel', endGDrag);
    const focusName = id => setTimeout(() => treeEl.querySelector(`[data-g="${CSS.escape(id)}"] .pf-be-name`)?.focus(), 30);
    treeEl.addEventListener('input', ev => {
        const inp = ev.target.closest('.pf-be-name'); if (!inp) return;
        const g = draft.find(x => x.id === inp.closest('[data-g]').dataset.g); if (g) { g.name = inp.value; refreshTags(); updateActions(); }
    });
    treeEl.addEventListener('click', ev => {
        if (ev.target.closest('.pf-be-grip')) return;   // 손잡이는 끌기 전용
        const li = ev.target.closest('[data-g]'); if (!li) return;
        const g = draft.find(x => x.id === li.dataset.g);
        const act = ev.target.closest('[data-act]')?.dataset.act;
        if ((act === 'up' || act === 'down') && g) { stepDraft(g, act === 'up' ? -1 : 1); return; }
        if (act === 'sub' && g) { const k = addGroup(g.id); if (selected.size) putInto(k); renderTree(); refilter(); focusName(k.id); return; }
        if (act === 'excl' && g) { g.exclusive = !g.exclusive; const b = ev.target.closest('[data-act]'); b.classList.toggle('on', !!g.exclusive); b.setAttribute('aria-pressed', String(!!g.exclusive)); return; }   // 다시 그리지 않음(깜빡임 없게)
        if (act === 'del' && g) {
            // 확인 · 취소 창을 띄운 뒤 풂 (마우스 · 터치 똑같이)
            (async () => {
                const ok = await callGenericPopup(`${escapeHtml(tr`Ungroup "${g.name || tr`(no name)`}"?`)}<br><small>${escapeHtml(ungroupNote(g, draft))}</small>`, POPUP_TYPE.CONFIRM);
                if (!ok) return;
                draft = ungroupFrom(draft, g);
                if (sel === g.id) sel = null;
                renderTree(); refreshTags(); refilter();
            })();
            return;
        }
        // 고르기는 표시만 바꿈(목록을 다시 그리지 않아 깜빡이지 않음) — 이름 칸을 누르면 바로 편집, 고른 그룹을 한 번 더 누르면 풀림
        const next = ev.target.closest('.pf-be-name') ? li.dataset.g : (sel === li.dataset.g ? null : li.dataset.g);
        if (next !== sel) {
            sel = next;
            treeEl.querySelectorAll('[data-g]').forEach(x => { const on = x.dataset.g === sel; x.classList.toggle('pf-be-sel', on); x.setAttribute('aria-selected', String(on)); });
            updateActions();
            if (filter === 'mine') refilter();
        }
    });
    root.querySelector('.pf-be-add').addEventListener('click', () => { const g = addGroup(scopeId && draft.some(x => x.id === scopeId) ? scopeId : null); if (selected.size) putInto(g); renderTree(); refilter(); focusName(g.id); });

    // 토글 목록 — 고르기는 예전 편집 창과 같음 (누르기 · Shift 범위 · 끌어 칠하기 · 폰은 길게 누른 뒤 끌기)
    for (const it of order) {
        const li = document.createElement('li');
        li.className = 'pf-ed-row' + (it.divider ? ' pf-ed-div' : '') + (it.on ? '' : ' pf-ed-off');
        li.dataset.id = it.id;
        li.setAttribute('role', 'option');
        li.innerHTML = `<span class="pf-ed-grip" title="${e(tr`Drag to reorder`)}"><i class="fa-solid fa-grip-lines"></i></span><input type="checkbox" tabindex="-1"><span class="pf-ed-pos">#${it.pos}</span><span class="pf-ed-name-text">${e(it.name)}</span><span class="pf-ed-how" hidden></span><span class="pf-new-badge pf-new-word pf-ed-new" hidden>${e(tr`New`)}</span><span class="pf-ed-tag"></span>`;
        list.append(li);
    }
    const rows = [...list.children];
    const rowOf = new Map(rows.map(li => [li.dataset.id, li]));
    function refreshTags() {
        const t = tree();
        rows.forEach(li => {
            const g = groupOf(li.dataset.id), tag = li.querySelector('.pf-ed-tag');
            tag.hidden = !g;
            if (g) { tag.style.setProperty('--pf-color', colorOf(g)); tag.textContent = t.path(g).map(y => y.name || tr`(no name)`).join(' › '); }
            const how = g && impRes?.how[li.dataset.id], hw = li.querySelector('.pf-ed-how');
            hw.hidden = !how;
            hw.textContent = how === 'name' ? tr`by name` : how === 'placed' ? tr`new toggle` : '';
            // 자동 그룹: 이번에 그룹이 바뀐 토글 — 기존 그룹에 들어감 / 새 그룹
            const nw = li.querySelector('.pf-ed-new'), moved = movedHere(li.dataset.id);
            nw.hidden = !moved;
            if (moved) nw.title = isOld(g) ? tr`Goes into an existing group` : tr`Goes into a new group`;
            li.classList.toggle('pf-ed-changed', moved);
        });
    }
    const setRow = (li, on) => {
        li.querySelector('input').checked = on;
        li.classList.toggle('pf-ed-sel', on);
        li.setAttribute('aria-selected', String(on));
        if (on) selected.add(li.dataset.id); else selected.delete(li.dataset.id);
    };
    function updateActions() {
        const g = draft.find(x => x.id === sel);
        count.textContent = tr`${selected.size} selected`;
        putBtn.textContent = g ? tr`Put in "${g.name || tr`(no name)`}"` : tr`Pick a group on the left`;
        putBtn.disabled = !g || !selected.size;
        outBtn.disabled = !selected.size;
        root.querySelector('.pf-be-actions').classList.toggle('pf-be-idle', !selected.size);
    }
    let last = null, paint = null, press = null;
    const changed = () => updateActions();
    const rangeTo = (idx, on) => { const [a, b] = [Math.min(last, idx), Math.max(last, idx)]; for (let i = a; i <= b; i++) if (!rows[i].hidden) setRow(rows[i], on); };
    // 손잡이로 끌어 그룹 안 순서 바꾸기 (마우스 · 터치 같음)
    let grab = null;
    list.addEventListener('pointerdown', ev => {
        const grip = ev.target.closest('.pf-ed-grip'); if (!grip) return;
        const li = grip.closest('.pf-ed-direct'); if (!li || !list.classList.contains('pf-be-reorder')) return;
        ev.preventDefault(); ev.stopImmediatePropagation();
        grip.setPointerCapture?.(ev.pointerId);
        grab = { li, g: draft.find(x => x.id === sel) };
        li.classList.add('pf-ed-grab');
    }, true);
    list.addEventListener('pointermove', ev => {
        if (!grab) return;
        ev.preventDefault();
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.pf-ed-direct');
        if (!over || over === grab.li || !list.contains(over)) return;
        const r = over.getBoundingClientRect();
        over[ev.clientY < r.top + r.height / 2 ? 'before' : 'after'](grab.li);
    }, true);
    const drop = () => {
        if (!grab) return;
        const { li, g } = grab; grab = null;
        li.classList.remove('pf-ed-grab');
        if (!g) return;
        const next = [...list.querySelectorAll('.pf-ed-direct')].map(x => x.dataset.id).filter(id => g.members.includes(id));
        if (next.join() !== g.members.join()) { g.members = next; custom.add(g.id); }
    };
    list.addEventListener('pointerup', drop, true);
    list.addEventListener('pointercancel', drop, true);
    list.addEventListener('pointerdown', ev => {
        const li = ev.target.closest('.pf-ed-row');
        if (!li || ev.button !== 0) return;
        const idx = rows.indexOf(li);
        if (ev.pointerType !== 'mouse') {
            press = { li, idx, x: ev.clientX, y: ev.clientY, long: false };
            press.timer = setTimeout(() => { if (!press) return; press.long = true; paint = !selected.has(li.dataset.id); setRow(li, paint); last = idx; changed(); navigator.vibrate?.(12); }, 450);
            return;
        }
        ev.preventDefault();
        const on = !selected.has(li.dataset.id);
        if (ev.shiftKey && last != null) rangeTo(idx, on); else { setRow(li, on); paint = on; }
        last = idx; changed();
    });
    list.addEventListener('touchmove', ev => {
        if (!press?.long || paint === null) return;
        ev.preventDefault();
        const t = ev.touches[0], li = document.elementFromPoint(t.clientX, t.clientY)?.closest?.('.pf-ed-row');
        if (li && list.contains(li) && !li.hidden) { setRow(li, paint); changed(); }
    }, { passive: false });
    list.addEventListener('pointermove', ev => { if (press && !press.long && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 8) { clearTimeout(press.timer); press = null; } });
    list.addEventListener('pointerup', () => { if (!press) return; clearTimeout(press.timer); if (!press.long) { setRow(press.li, !selected.has(press.li.dataset.id)); last = press.idx; changed(); } press = null; });
    list.addEventListener('pointercancel', () => { if (press && !press.long) { clearTimeout(press.timer); press = null; } });
    list.addEventListener('touchend', () => { if (press?.long) { press = null; paint = null; } });
    list.addEventListener('contextmenu', ev => { if (ev.target.closest('.pf-ed-row')) ev.preventDefault(); });
    list.addEventListener('pointerover', ev => { if (paint === null) return; const li = ev.target.closest('.pf-ed-row'); if (li) { setRow(li, paint); changed(); } });
    const stopPaint = () => { paint = null; };
    document.addEventListener('pointerup', stopPaint);
    list.addEventListener('click', ev => ev.preventDefault());

    // 넣기 · 빼기: 고른 토글을 다른 그룹에서 빼고 고른 그룹에 (실제 순서대로)
    function putInto(g) {
        const ids = [...selected].sort((p, q) => (at.get(p) ?? 1e9) - (at.get(q) ?? 1e9));
        draft.forEach(x => { x.members = x.members.filter(id => !selected.has(id)); });
        // 순서를 직접 바꾼 그룹은 그 순서 뒤에 붙이고, 아니면 실제 순서대로
        g.members = custom.has(g.id) ? [...g.members, ...ids] : [...g.members, ...ids].sort((p, q) => (at.get(p) ?? 1e9) - (at.get(q) ?? 1e9));
    }
    const afterMove = () => { rows.forEach(li => setRow(li, false)); last = null; renderTree(); refreshTags(); refilter(); };
    putBtn.addEventListener('click', () => { const g = draft.find(x => x.id === sel); if (!g || !selected.size) return; putInto(g); afterMove(); });
    outBtn.addEventListener('click', () => { if (!selected.size) return; draft.forEach(x => { x.members = x.members.filter(id => !selected.has(id)); }); afterMove(); });
    root.querySelector('.pf-be-clear').addEventListener('click', () => { rows.forEach(li => setRow(li, false)); changed(); });

    const search = root.querySelector('.pf-search input');
    // 「이 그룹 편집」은 그 그룹 토글만 보이게 시작 (다른 토글을 넣으려면 「전체」)
    let filter = scopeId ? 'mine' : 'all';
    function refilter() {
        const q = search.value.trim().toLowerCase();
        const g = draft.find(x => x.id === sel), mine = new Set(g ? tree().allItems(g) : []);
        rows.forEach((li, i) => {
            const id = order[i].id;
            const okF = filter === 'all' || (filter === 'changed' ? movedHere(id) : filter === 'mine' ? (sel === '' ? !groupOf(id) : mine.has(id)) : !groupOf(id));
            li.hidden = !okF || (!!q && !order[i].name.toLowerCase().includes(q));
        });
        // 「고른 그룹」 보기: 그 그룹 토글을 그룹 안 순서대로 · 끌어서 순서 바꾸기
        const reorder = filter === 'mine' && !!g && !q;
        list.classList.toggle('pf-be-reorder', reorder);
        const direct = new Set(reorder ? g.members : []);
        const seq = reorder ? [...g.members.map(id => rowOf.get(id)).filter(Boolean), ...rows.filter(li => !direct.has(li.dataset.id))] : rows;
        if (seq.some((li, i) => list.children[i] !== li)) list.append(...seq);
        rows.forEach(li => li.classList.toggle('pf-ed-direct', direct.has(li.dataset.id)));
        root.querySelectorAll('.pf-be-filter .pf-ed-chip').forEach(c => c.setAttribute('aria-checked', String(c.dataset.f === filter)));
    }
    root.querySelectorAll('.pf-be-filter .pf-ed-chip').forEach(c => c.addEventListener('click', () => { filter = c.dataset.f; refilter(); }));
    search.addEventListener('input', refilter);

    // 자동 그룹: 그룹 없는 토글만 / 전부 새로 · AI로 다시 묶기 (결과는 이 편집기에 그대로)
    if (auto) {
        const paintMode = () => {
            root.querySelectorAll('.pf-be-mode .pf-ed-chip').forEach(c => c.setAttribute('aria-checked', String(c.dataset.m === mode)));
            // 「이번에 바뀐 것」은 「그룹 없는 토글만」에서만
            const ch = root.querySelector('.pf-be-filter .pf-ed-chip[data-f="changed"]');
            if (ch) ch.hidden = mode !== 'free';
            if (mode !== 'free' && filter === 'changed') filter = 'all';
        };
        root.querySelectorAll('.pf-be-mode .pf-ed-chip').forEach(c => c.addEventListener('click', () => { mode = c.dataset.m; draft = autoDraft(); sel = null; paintMode(); setSummary(mode === 'free' && fitInto.size ? intoNote() : plan.length ? tr`Grouped by divider toggles and similar names. Fix names, move toggles, then create.` : tr`Couldn't find anything to group automatically in this preset. Try regrouping with AI.`); if (noneLeft()) setSummary(tr`Every toggle is already in a group, so there is nothing to group. Pick "Regroup everything" to start over.`); renderTree(); refreshTags(); refilter(); }));
        paintMode();
        bindAiPickers(root);
        const aiBtn = root.querySelector('.pf-auto-ai-run');
        let running = null;
        aiBtn.addEventListener('click', async () => {
            const label = aiBtn.querySelector('span');
            if (running) { running.abort(); return; }   // 다시 누르면 멈춤
            // 「그룹 없는 토글만」이면 그룹에 없는 토글만 보내고 그것만 묶음 (기존 그룹은 그대로)
            const grouped = new Set(mode === 'free' ? data.groups.flatMap(g => g.members) : []);
            const sendOrder = rawOrder.filter(x => !grouped.has(x.identifier));
            if (sendOrder.filter(x => getPrompt(x.identifier)).length < 2) return void toastr.info(mode === 'free' ? tr`No toggles left outside groups to group.` : tr`AI found nothing to group.`, tr`Prompt Folders`);
            const known = mode === 'free' ? data.groups.filter(g => g.members.length) : [];
            if (!(await confirmAiSend(sendOrder.filter(x => getPrompt(x.identifier)).length, known.length))) return;
            running = new AbortController();
            const t0 = Date.now();
            const tick = () => { label.textContent = tr`AI is grouping… ${Math.round((Date.now() - t0) / 1000)}s (click to stop)`; };
            tick(); const timer = setInterval(tick, 1000);
            aiBtn.classList.add('pf-busy');
            try {
                const next = await aiPlan(sendOrder, getPrompt, running.signal, mode === 'free' ? data.groups : null);
                if (!next.length && !next.into?.size) { toastr.info(tr`AI found nothing to group.`, tr`Prompt Folders`); return; }
                plan = next;   // 고른 방식(그룹 없는 토글만 / 전부 새로)은 그대로
                draft = autoDraft(); sel = null;
                setSummary(mode === 'free' && fitInto.size ? intoNote() : tr`Grouped by AI. Fix names, move toggles, then create.`);
                renderTree(); refreshTags(); refilter();
            } catch (err) {
                if (!running?.signal.aborted) toastr.error(`${tr`Regroup with AI`}: ${String(err?.message || err)}`, tr`Prompt Folders`);
            } finally { clearInterval(timer); running = null; aiBtn.classList.remove('pf-busy'); label.textContent = tr`Regroup with AI`; }
        });
    }

    if (imp) {
        const stats = root.querySelector('.pf-imp-stats');
        const showStats = () => { stats.textContent = remapStats(impRes); };
        showStats();
        root.querySelector('.pf-imp-from')?.addEventListener('change', ev => {
            impSrc = imp[Number(ev.target.value)]; draft = runImport(); sel = null;
            showStats(); renderTree(); refreshTags(); refilter();
        });
    }

    renderTree(); refreshTags(); refilter();
    if (addNew && sel) focusName(sel);
    // 창 위아래에 장식 여백이 큰 테마나 낮은 화면에서는 「화면의 78%」 편집기가 창보다 커져 아래 단추가 창 테두리에 잘렸음 → 열린 뒤 남는 높이에 맞춤
    const fit = () => fitEditorHeight(root);
    setTimeout(fit, 0); setTimeout(fit, 250);
    window.addEventListener('resize', fit);
    const ok = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: imp ? tr`Bring groups` : auto ? tr`Create` : tr`Save`, cancelButton: tr`Cancel`, wide: true, large: !scopeId, allowVerticalScrolling: true });
    window.removeEventListener('resize', fit);
    document.removeEventListener('pointerup', stopPaint);
    if (!ok) return;

    // 빈 그룹(토글도 하위 그룹도 없음)은 버리고, 이름이 비면 안 토글 이름으로
    const t = tree();
    draft = draft.filter(g => t.allItems(g).length);
    const t2 = makeTree(draft);
    draft.forEach(g => { if (!String(g.name || '').trim()) { const ids = t2.allItems(g); g.name = nameOf(ids[1] ?? ids[0]) || tr`Group ${draft.indexOf(g) + 1}`; } });
    // 바뀐 게 하나도 없으면 저장하지 않음 (예: 모든 토글이 이미 그룹에 있는데 「그룹 없는 토글만」으로 만들기)
    if (!custom.size && JSON.stringify(draft) === JSON.stringify(data.groups)) {
        return void toastr.info(auto ? tr`No new groups to create, so nothing changed.` : tr`Nothing changed.`, tr`Prompt Folders`);
    }
    const madeNew = draft.filter(g => !data.groups.some(x => x.id === g.id)).length;
    // 「그룹 없는 토글만」: 기존 그룹에 넣은 토글 수 · 새 그룹 수
    const intoOld = draft.filter(g => isOld(g)).reduce((n, g) => n + g.members.filter(id => origOf.get(id) !== g.id && !origOf.has(id)).length, 0);
    if (auto && mode === 'all' && data.groups.length) {
        const sure = await callGenericPopup(escapeHtml(tr`Remove the current ${data.groups.length} groups of this preset and regroup? The toggles themselves are not changed.`), POPUP_TYPE.CONFIRM);
        if (!sure) return;
    }
    const snap = takeSnap();
    // 그룹 안 순서를 바꿨으면 실제 순서도: 그 토글들이 있던 자리는 그대로 두고 그 안에서만 차례를 바꿈
    const moved = draft.filter(g => custom.has(g.id));
    if (moved.length) {
        const cur = pm.getPromptOrderForCharacter(pm.activeCharacter).slice();
        for (const g of moved) {
            const want = g.members.filter(id => cur.some(x => x.identifier === id));
            const slots = cur.map((x, i) => (want.includes(x.identifier) ? i : -1)).filter(i => i >= 0);
            const entries = want.map(id => cur.find(x => x.identifier === id));
            slots.forEach((slot, k) => { cur[slot] = entries[k]; });
        }
        pm.removePromptOrderForCharacter(pm.activeCharacter);
        pm.addPromptOrderForCharacter(pm.activeCharacter, cur);
        pm.saveServiceSettings();
        pm.render();
    }
    // 그룹 순서를 바꿨으면: 「내가 정한 순서」 배치는 배열 순서만, 「실제 순서」 배치는 프롬프트 순서에서도 그룹 덩어리 차례를 바꿈
    // (그룹이 아닌 토글 자리는 그대로 두고, 그룹들이 있던 자리에 새 차례대로 채움 — 하위 그룹도 같은 방식)
    if (reordered && !isCustomLayout()) {
        const tf = makeTree(draft);
        const arrange = (seq, gs) => {
            const owner = new Map();
            gs.forEach(g => tf.allItems(g).forEach(id => owner.set(id, g)));
            const rest = [], anchors = [], blocks = new Map(gs.map(g => [g, []]));
            for (const id of seq) {
                const g = owner.get(id);
                if (!g) { rest.push(id); continue; }
                if (!blocks.get(g).length) anchors.push(rest.length);
                blocks.get(g).push(id);
            }
            for (const g of gs) blocks.set(g, arrange(blocks.get(g), draft.filter(k => tf.parentOf(k) === g)));
            const present = gs.filter(g => blocks.get(g).length);
            const out = [];
            let k = 0;
            for (let i = 0; i <= rest.length; i++) {
                while (k < present.length && anchors[k] === i) out.push(...blocks.get(present[k++]));
                if (i < rest.length) out.push(rest[i]);
            }
            return out;
        };
        const cur = pm.getPromptOrderForCharacter(pm.activeCharacter).slice();
        const ids = arrange(cur.map(x => x.identifier), draft.filter(g => !tf.parentOf(g)));
        if (ids.join() !== cur.map(x => x.identifier).join()) {
            const byId = new Map(cur.map(x => [x.identifier, x]));
            pm.removePromptOrderForCharacter(pm.activeCharacter);
            pm.addPromptOrderForCharacter(pm.activeCharacter, ids.map(id => byId.get(id)));
            pm.saveServiceSettings();
            pm.render();
        }
    }
    data.groups = draft;
    settings().view = 'grouped';
    save();
    apply();
    offerRestore(snap, imp ? tr`Groups imported.` : auto && mode === 'free' ? tr`${intoOld} toggles went into existing groups · ${madeNew} new groups.` : auto ? tr`${madeNew} groups created.` : tr`Groups saved.`);
}


/** 그룹 풀기: 안의 그룹은 한 단계 위로, 하위 그룹이면 안의 토글도 위 그룹으로 올라감(예전엔 그룹 밖으로 빠져 위 그룹이 비면 같이 사라졌음) */
function ungroupFrom(groups, g) {
    const parent = g.parent ? groups.find(x => x.id === g.parent) : null;
    groups.forEach(x => { if (x.parent === g.id) x.parent = g.parent || null; });
    if (parent) for (const id of g.members || []) if (!parent.members.includes(id)) parent.members.push(id);
    return groups.filter(x => x !== g);
}

function ungroupNote(g, groups) {
    const parent = g.parent ? groups.find(x => x.id === g.parent) : null;
    return parent
        ? tr`The toggles inside move up into "${parent.name || tr`(no name)`}". Groups inside move up one level.`
        : tr`The toggles inside are not deleted and stay where they are. Groups inside move up one level.`;
}

async function deleteGroup(g) {
    const data = presetData();
    const ok = await callGenericPopup(`${escapeHtml(tr`Ungroup "${g.name}"?`)}<br><small>${escapeHtml(ungroupNote(g, data.groups))}</small>`, POPUP_TYPE.CONFIRM);
    if (!ok) return;
    const snap = takeSnap();
    data.groups = ungroupFrom(data.groups, g);
    save();
    apply();
    offerRestore(snap, tr`Ungrouped "${g.name}".`);
}

// ---------------- 감시 ----------------

function scheduleApply() {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => { apply(); syncRowMetrics(); }, 30);
}

/** 그룹 머리 줄 높이를 테마의 프롬프트 줄(한 줄짜리) 높이에 맞춤 — 테마마다 31~51px 로 달라서 고정 34px 이면 튀었음 */
const rowWatched = new WeakSet();
let rowTimer = null;
function syncRowMetrics() {
    const list = document.getElementById(LIST_ID);
    if (!list) return;
    // 테마를 바꿀 때 프롬프트 창이 닫혀 있으면 잴 줄이 없음 → 목록이 보이거나 크기가 바뀌면 다시 잼 (실리태번이 목록을 새로 만들 수 있어 목록마다 한 번 붙임)
    if (window.ResizeObserver && !rowWatched.has(list)) {
        rowWatched.add(list);
        // 폭이 바뀔 때(테마 · 패널 크기)만 다시 잼 — 그룹을 열고 닫아 높이만 바뀔 때 다시 재면
        // 새로 보이는 줄 때문에 값이 1px 오가며 위 그룹 머리들이 한 박자 늦게 움직였음(「뚜둑」)
        let lastW = -1;
        new ResizeObserver(([e]) => {
            const w = Math.round(e.contentRect.width);
            if (w === lastW && list.style.getPropertyValue('--pf-row-h')) return;
            lastW = w;
            clearTimeout(rowTimer); rowTimer = setTimeout(syncRowMetrics, 80);
        }).observe(list);
    }
    const heights = [];
    // 그룹 안 줄은 원래 줄의 복사본(pf-clone)이라 data-pm-identifier 가 없음 — 보이는 프롬프트 줄이면 다 잼
    for (const row of list.querySelectorAll('li.completion_prompt_manager_prompt:not(.completion_prompt_manager_list_head):not(.pf-hidden)')) {
        let h = row.offsetHeight;
        // 이름이 좁은 칸에서 두 줄로 꺾인 줄은 한 줄짜리 높이로 바꿔 잼(폰에서 모든 줄이 꺾이면 그룹 머리가 두 줄 높이가 되던 것)
        const name = row.querySelector('.completion_prompt_manager_prompt_name');
        const lh = name ? parseFloat(getComputedStyle(name).lineHeight) : NaN;
        if (name && lh > 0) {
            const lines = Math.round(name.offsetHeight / lh);
            if (lines > 1) h -= (lines - 1) * lh;
        }
        if (h) heights.push(Math.round(h));
        if (heights.length >= 12) break;
    }
    syncRowLook(list);   // 모양은 숨긴 원래 줄로도 잴 수 있어서 그룹이 다 접혀 있어도 잼
    if (!heights.length) return;   // 모두 접혀 있으면 지난 값 그대로
    const rowH = Math.min(...heights) + 'px';
    if (list.style.getPropertyValue('--pf-row-h') !== rowH) list.style.setProperty('--pf-row-h', rowH);
}

// 테마가 프롬프트 줄을 상자(테두리 · 바탕 · 둥근 모서리)로 그리면 그룹 머리도 같은 상자로 — 안쪽 줄만 테마를 따르고 그룹 머리는 맨글로 보였음
function syncRowLook(list) {
    // 켜진 줄만 칠하는 테마(켜짐 표시)도 있어서, 켜진 줄 · 꺼진 줄에 같이 있는 모양만 따름 — 그룹 머리가 「켜진 토글」처럼 보이지 않게
    // 보이는 줄이 없으면(그룹이 다 접힘) 숨겨 둔 원래 줄로 — 숨겨져 있어도 테마 색 · 테두리 값은 같음
    const pick = (q) => {
        // 마우스가 올라간 줄은 「올림」 색이라 빼고 잼
        const rows = [...list.querySelectorAll('li.completion_prompt_manager_prompt:not(.completion_prompt_manager_list_head)' + q)].filter(e => !e.matches(':hover, :focus-within'));
        return rows.find(e => e.offsetParent) || rows[0];
    };
    const on = pick(':not(.completion_prompt_manager_prompt_disabled):has(.prompt-manager-toggle-action)');
    const off = pick('.completion_prompt_manager_prompt_disabled:has(.prompt-manager-toggle-action)');
    if (!on && !off) return;
    const c = getComputedStyle(on || off);
    const d = getComputedStyle(off || on);
    const clear = (bg) => /^(transparent|rgba\(0, 0, 0, 0\))$/.test(bg);
    const boxed = parseFloat(c.borderTopWidth) > 0 && c.borderTopStyle !== 'none' && !clear(c.borderTopColor)
        && parseFloat(d.borderTopWidth) > 0 && d.borderTopStyle !== 'none';   // 테두리는 켜짐 · 꺼짐 둘 다 있으면(선 모양은 달라도) 켜진 줄 모양으로
    const filled = !clear(c.backgroundColor) && c.backgroundColor === d.backgroundColor;
    // 읽기를 모두 끝낸 뒤 바뀐 값만 한 번에 씀 — 읽기 · 쓰기를 번갈아 하면 쓸 때마다 화면 배치를 처음부터 다시 계산해서
    // 긴 채팅이 열려 있을 때 토글 하나 누를 때마다 1초 넘게 멈췄음
    const vals = new Map();
    const set = (k, v) => vals.set(k, v);
    set('--pf-row-border', boxed ? `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}` : null);
    set('--pf-row-radius', boxed || filled ? c.borderTopLeftRadius : null);
    set('--pf-row-bg', filled ? c.backgroundColor : null);
    set('--pf-row-shadow', (boxed || filled) && c.boxShadow !== 'none' ? c.boxShadow : null);
    set('--pf-row-gap', boxed || filled ? c.marginBottom : null);
    // 그룹 스위치 · ⋮ 도 그 테마의 토글 줄 아이콘(스위치 · 연필)과 같은 색 · 옅기 · 크기 · 그림자로 — 그룹 아이콘만 진하고 또렷했음
    // 고정 자리(마커) 줄엔 스위치 · 연필이 없어서, 그 아이콘이 있는 줄에서 잼
    const icon = (state, sel, key) => {
        const e = pick(state + ':has(' + sel + ')')?.querySelector(sel);
        const k = e && getComputedStyle(e);
        set(`--pf-${key}-color`, k ? k.color : null);
        set(`--pf-${key}-op`, k ? k.opacity : null);
        set(`--pf-${key}-size`, k ? k.fontSize : null);
        set(`--pf-${key}-filter`, k && k.filter !== 'none' ? k.filter : null);
    };
    icon(':not(.completion_prompt_manager_prompt_disabled)', '.prompt-manager-toggle-action', 'tg-on');
    icon('.completion_prompt_manager_prompt_disabled', '.prompt-manager-toggle-action', 'tg-off');
    icon('', '.prompt-manager-edit-action', 'ic');
    // 꺼진 토글 줄의 흐림(이름 색 · 줄 · 이름 칸 옅기) — 다 꺼진 그룹 머리에 같은 흐림
    // 테마가 꺼진 줄을 켜진 줄과 다르게(흐리게) 그릴 때만 — 같으면 그룹도 그대로
    const look = (row) => {
        const name = row?.querySelector('.completion_prompt_manager_prompt_name .prompt-manager-inspect-action');
        const block = row?.querySelector('.completion_prompt_manager_prompt_name');
        return name ? { color: getComputedStyle(name).color, op: +getComputedStyle(row).opacity * +getComputedStyle(block).opacity } : null;
    };
    const offLook = look(off), onLook = look(on);
    const dims = offLook && (!onLook || offLook.color !== onLook.color || offLook.op !== onLook.op);
    set('--pf-off-name', dims ? offLook.color : null);
    set('--pf-off-op', dims ? String(offLook.op) : null);
    for (const [k, v] of vals) {
        const cur = list.style.getPropertyValue(k);
        if (v == null) { if (cur) list.style.removeProperty(k); } else if (cur !== String(v)) list.style.setProperty(k, v);
    }
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
    syncRowMetrics();
    // 테마를 바꾸면 줄 높이가 달라지므로 다시 잼
    const themeCss = document.getElementById('custom-style');
    // 테마가 바뀌면 바로 한 번, 0.3초 뒤 한 번 더(다른 확장이 테마를 보고 붙이는 손질은 그 뒤에 들어옴)
    let lateSync;
    const resync = () => { syncRowMetrics(); clearTimeout(lateSync); lateSync = setTimeout(syncRowMetrics, 300); };
    if (themeCss) new MutationObserver(resync).observe(themeCss, { childList: true, characterData: true, subtree: true });
    // 테마 글자 · 바탕색(실리태번이 <html> style 에 넣는 변수)은 테마 CSS 와 따로 바뀜 → 그때도
    new MutationObserver(resync).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    // 프롬프트 창(왼쪽 패널)을 열거나 탭을 바꿀 때도 다시 잼 — 테마를 바꿀 땐 창이 닫혀 있어 잴 줄이 없을 수 있음
    document.addEventListener('click', (e) => {
        if (e.target?.closest?.('#ai-config-button .drawer-toggle, #left-nav-panel .openai-tab-buttons')) {
            setTimeout(syncRowMetrics, 150);
            setTimeout(syncRowMetrics, 600);
        } else if (e.target?.closest?.('.pf-group-head')) {
            // 그룹을 열고 닫을 땐 이미 잰 값을 그대로(다시 재면 위 그룹 머리들이 1px씩 늦게 움직임) — 아직 못 쟀을 때만
            const list = document.getElementById(LIST_ID);
            if (list && !list.style.getPropertyValue('--pf-row-h')) setTimeout(syncRowMetrics, 150);
        }
    }, true);

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

