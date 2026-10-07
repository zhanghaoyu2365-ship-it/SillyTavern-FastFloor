import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { promptQuietForLoudResponse } from '../../../slash-commands.js';

const EXT_KEY = 'fastFloor';

const defaults = {
    floors: 20,
    prompt: '继续',
};

let running = false;
let stopRequested = false;
let current = 0;
let target = 0;

function settings() {
    if (!extension_settings[EXT_KEY]) {
        extension_settings[EXT_KEY] = structuredClone(defaults);
    }

    for (const [key, value] of Object.entries(defaults)) {
        if (extension_settings[EXT_KEY][key] === undefined) {
            extension_settings[EXT_KEY][key] = value;
        }
    }

    return extension_settings[EXT_KEY];
}

function setStatus(text, kind = '') {
    const el = document.querySelector('#fastfloor_status');
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
}

function updateButtons() {
    $('#fastfloor_start').prop('disabled', running);
    $('#fastfloor_stop').prop('disabled', !running);
    $('#fastfloor_floors, #fastfloor_prompt').prop('disabled', running);
}

function validateContext() {
    const context = getContext();
    return Boolean(context?.characterId || context?.groupId || context?.groupID);
}

async function generateOneFloor(prompt) {
    // SillyTavern's own "quiet prompt -> loud response" pipeline.
    // The prompt is NOT added as a visible user message; only the AI reply becomes a new floor.
    await promptQuietForLoudResponse('user', prompt);
}

async function startFastFloor() {
    if (running) return;

    if (!validateContext()) {
        toastr.warning('请先打开一个角色或群聊。');
        return;
    }

    const floors = Math.max(1, Math.min(9999, parseInt($('#fastfloor_floors').val(), 10) || defaults.floors));
    const prompt = String($('#fastfloor_prompt').val() || '').trim() || defaults.prompt;

    const cfg = settings();
    cfg.floors = floors;
    cfg.prompt = prompt;
    saveSettingsDebounced();

    running = true;
    stopRequested = false;
    current = 0;
    target = floors;
    updateButtons();
    setStatus(`0 / ${target}，正在启动…`, 'running');

    try {
        for (let i = 0; i < target; i++) {
            if (stopRequested) break;

            setStatus(`${current} / ${target}，生成中…`, 'running');
            await generateOneFloor(prompt);

            current++;
            setStatus(`${current} / ${target}`, 'running');

            // Yield one browser tick so the UI can repaint; no artificial generation delay.
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (stopRequested) {
            setStatus(`已停止：${current} / ${target}`, 'stopped');
            toastr.info(`极速刷楼已停止：${current}/${target}`);
        } else {
            setStatus(`完成：${current} / ${target}`, 'done');
            toastr.success(`极速刷楼完成：${current} 层`);
        }
    } catch (error) {
        console.error('[FastFloor] generation failed', error);
        setStatus(`出错：${current} / ${target}`, 'error');
        toastr.error(`刷楼中断：${error?.message || error}`);
    } finally {
        running = false;
        stopRequested = false;
        updateButtons();
    }
}

function stopFastFloor() {
    if (!running) return;
    stopRequested = true;
    setStatus(`正在停止… ${current} / ${target}`, 'stopped');
}

function buildUI() {
    if (document.querySelector('#fastfloor_settings')) return;

    const cfg = settings();
    const html = `
        <div id="fastfloor_settings" class="fastfloor-block">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>⚡ 极速刷楼</b>
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
                    <small class="fastfloor-hint">提示词不会显示成你的消息；每次只新增一条 AI 回复。上一层完成后立即生成下一层。</small>
                    <div class="fastfloor-actions">
                        <button id="fastfloor_start" class="menu_button">▶ 开始</button>
                        <button id="fastfloor_stop" class="menu_button" disabled>■ 停止</button>
                    </div>
                    <div id="fastfloor_status" class="fastfloor-status">待机</div>
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

    $('#fastfloor_start').on('click', startFastFloor);
    $('#fastfloor_stop').on('click', stopFastFloor);

    $('#fastfloor_floors').on('change', function () {
        settings().floors = Math.max(1, parseInt(this.value, 10) || defaults.floors);
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
