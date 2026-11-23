import * as Tavern from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { is_group_generating } from '../../../group-chats.js';
import { power_user } from '../../../power-user.js';
import { createFloorRunner, getStreamText } from './runner.js';
import { hideChatMessageRange } from '../../../chats.js';
import { markGenerated, visibilityTargets, applyVisibility } from './visibility.js';

const EXT_KEY = 'fastFloor';
const defaults = { floors: 20, prompt: '继续', autoHide: true };
const clampFloors = value => Math.max(1, Math.min(9999, parseInt(value, 10) || defaults.floors));
let inputWasDisabled = false;
let bulkBusy = false;

function settings() {
    if (!extension_settings[EXT_KEY] || typeof extension_settings[EXT_KEY] !== 'object') {
        extension_settings[EXT_KEY] = { ...defaults };
    }
    const cfg = extension_settings[EXT_KEY];
    cfg.floors = clampFloors(cfg.floors);
    cfg.prompt = String(cfg.prompt ?? '').trim() || defaults.prompt;
    cfg.autoHide = cfg.autoHide !== false;
    return cfg;
}

function context() {
    const ctx = getContext();
    return { ...ctx, groupId: ctx.groupId || null, chatId: ctx.getCurrentChatId?.() ?? ctx.chatId };
}

function checkReady() {
    const ctx = context();
    if (ctx.characterId == null && ctx.groupId == null) throw new Error('请先打开一个角色或群聊。');
    if (!ctx.chatId || !Array.isArray(ctx.chat)) throw new Error('请先等待聊天加载完成。');
    if (Tavern.is_send_press || is_group_generating) throw new Error('酒馆正在生成，请等结束后再开始。');
    if (ctx.onlineStatus === 'no_connection') throw new Error('请先连接 API。');
    if (!Tavern.isStreamingEnabled?.()) throw new Error('出字即停需要在酒馆 API 设置中开启「流式传输」。');
    if (!ctx.eventTypes.STREAM_TOKEN_RECEIVED || !ctx.eventTypes.GENERATION_STOPPED || !ctx.eventTypes.CHAT_CHANGED) {
        throw new Error('当前酒馆版本缺少流式事件，请更新 SillyTavern。');
    }
    if (String($('#send_textarea').val() ?? '').trim()) throw new Error('输入框里有未发送的文字，请先发送或保存草稿。');
}

function setStatus(text, kind = '') {
    const el = document.querySelector('#fastfloor_status');
    if (el) { el.textContent = text; el.dataset.kind = kind; }
}

const visibilityHost = {
    context,
    hideRange: hideChatMessageRange,
    syncSwipe: index => Tavern.syncMesToSwipe?.(index),
};

async function finalizeRound(origin, before) {
    const ctx = context();
    if (ctx.chat !== origin.chat || ctx.chatId !== origin.chatId) return;
    const added = ctx.chat.slice(before);
    if (added.length !== 1 || added[0].is_user || added[0].is_system) return;
    markGenerated(added[0]);
    visibilityHost.syncSwipe(before);
    if (settings().autoHide) {
        await applyVisibility(visibilityHost, [{ index: before, message: added[0] }], true);
    } else {
        await ctx.saveChat();
    }
}

async function bulkVisibility(hidden) {
    if (runner.running || bulkBusy || Tavern.is_send_press || is_group_generating) {
        toastr.info('请先停止刷楼并等待当前生成结束，再批量操作。');
        return;
    }
    bulkBusy = true;
    updateButtons();
    try {
        const ctx = context();
        if (!ctx.chatId) throw new Error('请先打开一个聊天。');
        const targets = visibilityTargets(ctx.chat, {
            scope: $('#fastfloor_scope').val(),
            start: $('#fastfloor_from').val(),
            end: $('#fastfloor_to').val(),
            hidden,
        });
        const count = await applyVisibility(visibilityHost, targets, hidden);
        setStatus(`${hidden ? '已隐藏' : '已恢复'} ${count} 条消息`, 'done');
        toastr.info(count ? `${hidden ? '已隐藏' : '已恢复'} ${count} 条消息` : '当前范围没有需要处理的消息。');
    } catch (error) {
        setStatus(String(error?.message || error), 'error');
        toastr.error(String(error?.message || error));
    } finally {
        bulkBusy = false;
        updateButtons();
    }
}

const runner = createFloorRunner({
    context,
    checkReady,
    status: setStatus,
    finalizeRound,
    stopGeneration: () => Tavern.stopGeneration(),
    streamText: (text, stream, message) => getStreamText(Tavern.cleanUpMessage({
        getMessage: String(text ?? ''),
        isImpersonate: false,
        isContinue: false,
        displayIncompleteSentences: true,
        includeUserPromptBias: false,
    }), stream, message, power_user.reasoning),
    on(name, handler) {
        const ctx = context();
        const event = ctx.eventTypes[name];
        ctx.eventSource.on(event, handler);
        return () => ctx.eventSource.removeListener(event, handler);
    },
    running(value) {
        $('#fastfloor_start').prop('disabled', value);
        $('#fastfloor_stop').prop('disabled', !value);
        $('#fastfloor_floors, #fastfloor_prompt').prop('disabled', value);
        $('#fastfloor_autohide, #fastfloor_scope, #fastfloor_from, #fastfloor_to, #fastfloor_hide, #fastfloor_show').prop('disabled', value);
        if (value) inputWasDisabled = Boolean($('#send_textarea').prop('disabled'));
        $('#send_textarea').prop('disabled', value || inputWasDisabled);
    },
    async generate(prompt) {
        const ctx = context();
        const options = { automatic_trigger: true, quiet_prompt: ctx.name1 + ': ' + prompt, quietToLoud: true };
        if (ctx.groupId != null) {
            // Exactly one member per floor; prefer the last enabled speaker.
            const group = ctx.groups.find(item => String(item.id) === String(ctx.groupId));
            const enabled = (group?.members ?? []).filter(avatar => !group.disabled_members?.includes(avatar));
            const previous = [...ctx.chat].reverse().find(message => !message.is_user && (!message.is_system || message.extra?.fastFloor?.generated) && enabled.includes(message.original_avatar));
            const avatar = previous?.original_avatar ?? enabled[0];
            const id = ctx.characters.findIndex(character => character.avatar === avatar);
            if (id < 0) throw new Error('群聊没有可用的角色。');
            options.force_chid = id;
        }
        // Normal streaming generation saves partial replies using native AI-message events.
        await ctx.generate('normal', options);
    },
    yield: () => new Promise(resolve => setTimeout(resolve, 0)),
});

async function startFastFloor() {
    if (runner.running || bulkBusy) return;
    const cfg = settings();
    cfg.floors = clampFloors($('#fastfloor_floors').val());
    cfg.prompt = String($('#fastfloor_prompt').val() ?? '').trim() || defaults.prompt;
    $('#fastfloor_floors').val(cfg.floors);
    Tavern.saveSettingsDebounced();
    try {
        const result = await runner.start({ floors: cfg.floors, prompt: cfg.prompt });
        if (result && !result.cancelled) toastr.success('出字即停刷楼完成：' + result.current + ' 层');
    } catch (error) {
        console.error('[FastFloor]', error);
        if (!runner.running) setStatus(String(error?.message || error), 'error');
        toastr.error(String(error?.message || error));
    }
}

function stopFastFloor() {
    runner.stop();
}

function updateButtons() {
    $('#fastfloor_start').prop('disabled', runner.running || bulkBusy);
    $('#fastfloor_stop').prop('disabled', !runner.running);
    $('#fastfloor_floors, #fastfloor_prompt, #fastfloor_autohide, #fastfloor_scope, #fastfloor_from, #fastfloor_to, #fastfloor_hide, #fastfloor_show').prop('disabled', runner.running || bulkBusy);
}

const saveSettingsDebounced = Tavern.saveSettingsDebounced;

function buildUI() {
    if (document.querySelector('#fastfloor_settings')) return;

    const cfg = settings();
    const html = `
        <div id="fastfloor_settings" class="fastfloor-block">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>⚡ 极速刷楼 · 出字即停</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="fastfloor-row">
                        <label for="fastfloor_floors">刷楼层数</label>
                        <input id="fastfloor_floors" class="text_pole" type="number" min="1" max="9999" step="1" value="${Number(cfg.floors) || defaults.floors}">
                    </div>
                    <div class="fastfloor-row fastfloor-prompt-row">
                        <label for="fastfloor_prompt">隐藏提示词</label>
                        <input id="fastfloor_prompt" class="text_pole" type="text" value="">
                    </div>
                    <small class="fastfloor-hint">v1.2.0 · 思考或正文一出字就打断，再生成下一层。需要开启流式传输。</small>
                    <label class="checkbox_label" for="fastfloor_autohide">
                        <input id="fastfloor_autohide" type="checkbox">
                        <span>新刷出的消息自动隐藏</span>
                    </label>
                    <small class="fastfloor-hint">使用酒馆隐藏功能：消息保留，但不再发送给模型。</small>
                    <div class="fastfloor-actions">
                        <button type="button" id="fastfloor_start" class="menu_button">▶ 开始</button>
                        <button type="button" id="fastfloor_stop" class="menu_button" disabled>■ 立即停止</button>
                    </div>
                    <details class="fastfloor-bulk">
                        <summary>批量隐藏 / 恢复</summary>
                        <div class="fastfloor-row">
                            <label for="fastfloor_scope">当前聊天范围</label>
                            <select id="fastfloor_scope" class="text_pole">
                                <option value="generated">本插件生成的消息</option>
                                <option value="range">指定楼层范围（仅 AI 消息）</option>
                            </select>
                        </div>
                        <div id="fastfloor_range" class="fastfloor-range" hidden>
                            <label for="fastfloor_from">起始楼层</label>
                            <input id="fastfloor_from" class="text_pole" type="number" min="0" step="1" placeholder="例如 10">
                            <label for="fastfloor_to">结束楼层</label>
                            <input id="fastfloor_to" class="text_pole" type="number" min="0" step="1" placeholder="例如 30">
                        </div>
                        <small class="fastfloor-hint">旧版刷出的消息请选择楼层范围。使用酒馆消息编号（从 0 开始），包含首尾；跳过用户消息。恢复只处理本插件隐藏的消息。</small>
                        <div class="fastfloor-actions">
                            <button type="button" id="fastfloor_hide" class="menu_button">批量隐藏</button>
                            <button type="button" id="fastfloor_show" class="menu_button">恢复所选隐藏</button>
                        </div>
                    </details>
                    <div id="fastfloor_status" class="fastfloor-status" role="status" aria-live="polite">待机 · 出字即停</div>
                </div>
            </div>
        </div>`;

    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!container) {
        console.warn('[FastFloor] extensions settings container not found');
        return;
    }

    container.insertAdjacentHTML('beforeend', html);
    $('#fastfloor_prompt').val(cfg.prompt || defaults.prompt);
    $('#fastfloor_autohide').prop('checked', cfg.autoHide);
    $('#fastfloor_autohide').on('change', function () {
        settings().autoHide = this.checked;
        saveSettingsDebounced();
    });
    $('#fastfloor_scope').on('change', function () {
        $('#fastfloor_range').prop('hidden', this.value !== 'range');
    });
    $('#fastfloor_hide').on('click', () => bulkVisibility(true));
    $('#fastfloor_show').on('click', () => bulkVisibility(false));

    $('#fastfloor_start').on('click', startFastFloor);
    $('#fastfloor_stop').on('click', stopFastFloor);

    $('#fastfloor_floors').on('change', function () {
        settings().floors = clampFloors(this.value); this.value = settings().floors;
        saveSettingsDebounced();
    });

    $('#fastfloor_prompt').on('change', function () {
        settings().prompt = String(this.value || '').trim() || defaults.prompt;
        saveSettingsDebounced();
    });
}

jQuery(() => {
    buildUI();
    updateButtons();
});
