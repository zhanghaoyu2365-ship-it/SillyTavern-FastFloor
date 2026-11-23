// No browser dependencies: the host supplies SillyTavern's generation lifecycle.
export function createFloorRunner(host) {
    let running = false;
    let cancelled = false;
    let reason = '';
    let round = null;
    let origin = null;
    let current = 0;
    let target = 0;
    let expectedStops = 0;

    const sameChat = () => {
        const now = host.context();
        return now.chat === origin.chat && now.chatId === origin.chatId
            && now.groupId === origin.groupId
            && (origin.groupId != null || now.characterId === origin.characterId);
    };
    const report = (message, kind = 'running') => host.status(message, kind);
    const interrupt = () => {
        expectedStops++;
        host.stopGeneration();
    };
    const stop = (message = '手动停止') => {
        if (!running || cancelled) return;
        cancelled = true;
        reason = message;
        report(`正在停止：${current} / ${target}（${reason}）`, 'stopped');
        if (round?.pending && (sameChat() || (round.stream && host.context().streamingProcessor === round.stream))) interrupt();
    };

    async function start({ floors, prompt }) {
        if (running) return;
        if (!Number.isInteger(floors) || floors < 1 || floors > 9999) throw new Error('层数须为 1–9999 的整数。');
        host.checkReady();
        origin = host.context();
        running = true;
        cancelled = false;
        reason = '';
        current = 0;
        target = floors;
        expectedStops = 0;
        host.running(true);
        const off = [];

        try {
            off.push(host.on('GENERATION_STOPPED', () => {
                if (expectedStops > 0) { expectedStops--; return; }
                // SillyTavern's own stop button must stop the entire batch too.
                cancelled = true;
                reason = '已点击酒馆停止按钮';
            }));
            off.push(host.on('CHAT_CHANGED', () => stop('已切换聊天')));
            off.push(host.on('STREAM_TOKEN_RECEIVED', text => {
                if (!round?.pending || round.cut || cancelled) return;
                if (!sameChat()) { stop('已切换聊天'); return; }
                const stream = host.context().streamingProcessor;
                if (!stream || stream.messageId < round.before || stream.type !== 'normal') return;
                round.stream = stream;
                const message = origin.chat[stream.messageId];
                if (!host.streamText(text, stream, message).trim()) return;
                // The streaming processor stores its current result before this event.
                // Stop synchronously, then await Generate's own finalization below.
                round.cut = true;
                report(`${current} / ${target}，已出字，正在保存本层…`);
                interrupt();
            }));

            while (current < target && !cancelled) {
                if (!sameChat()) { stop('已切换聊天'); break; }
                host.checkReady();
                round = { pending: true, cut: false, before: origin.chat.length };
                report(`${current} / ${target}，等待出字…`);
                try {
                    await host.generate(prompt);
                } catch (error) {
                    // Suppress only intentional cancellation, never arbitrary API errors.
                    if (!cancelled && !(round.cut && error?.name === 'AbortError')) throw error;
                } finally {
                    round.pending = false;
                }
                if (cancelled || !sameChat()) break;
                if (!round.cut) throw new Error('本层没有检测到可中断的文字（正文或思考），已停止。请检查酒馆版本、流式设置或接口返回内容。');
                const added = origin.chat.slice(round.before);
                if (added.length !== 1 || added[0].is_user || added[0].is_system || !hasSavedText(added[0])) {
                    throw new Error('本次没有保存一条有效 AI 回复，已停止；请检查接口或其他自动生成插件。');
                }
                current++;
                report(`${current} / ${target}`);
                // Yield for stop-button input without introducing a generation interval.
                await host.yield();
            }
            report(cancelled ? `已停止：${current} / ${target}（${reason}）` : `完成：${current} / ${target}`, cancelled ? 'stopped' : 'done');
            return { current, target, cancelled };
        } catch (error) {
            report(`中断：${current} / ${target}（${error?.message || error}）`, 'error');
            throw error;
        } finally {
            round = null;
            for (const remove of off) remove();
            running = false;
            host.running(false);
        }
    }

    return { start, stop, get running() { return running; } };
}

export function hasSavedText(message) {
    return Boolean(String(message?.mes ?? '').trim() || String(message?.extra?.reasoning ?? '').trim());
}

// Native streaming updates the reasoning handler BEFORE emitting the text event,
// but persists message.extra.reasoning later. Check both locations, not only text.
export function getStreamText(text, stream, message, { auto_parse, prefix, suffix } = {}) {
    const reasoning = String(stream?.reasoningHandler?.reasoning || message?.extra?.reasoning || '').trim();
    if (reasoning) return reasoning;
    let content = String(text ?? '').trimStart();
    if (auto_parse && prefix) {
        if (prefix.startsWith(content)) return '';
        if (content.startsWith(prefix)) content = content.slice(prefix.length);
        if (suffix) content = content.replace(suffix, '');
    }
    return content;
}
