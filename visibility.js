export function markGenerated(message) {
    message.extra ??= {};
    message.extra.fastFloor = { ...message.extra.fastFloor, generated: true };
}

export function visibilityTargets(chat, { scope = 'generated', start, end, hidden = true } = {}) {
    if (!['generated', 'range'].includes(scope)) throw new Error('请选择批量操作范围。');
    if (scope === 'range') {
        if (String(start ?? '').trim() === '' || String(end ?? '').trim() === '') throw new Error('请填写起始和结束楼层编号。');
        start = Number(start);
        end = Number(end);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= chat.length) {
            throw new Error(`楼层范围无效：请输入 0–${Math.max(0, chat.length - 1)} 内的编号，起始不能大于结束。`);
        }
    }
    return chat.flatMap((message, index) => {
        const tag = message.extra?.fastFloor;
        if (message.is_user) return [];
        if (scope === 'generated' && !tag?.generated) return [];
        if (scope === 'range' && (index < start || index > end)) return [];
        // Never unhide native system messages or messages hidden by someone else.
        if (hidden ? message.is_system : (!message.is_system || !tag?.hiddenByPlugin)) return [];
        return [{ index, message }];
    });
}

export async function applyVisibility(host, targets, hidden) {
    const origin = host.context();
    // Validate the complete selection before changing anything.
    if (targets.some(({ index, message }) => origin.chat[index] !== message)) throw new Error('聊天内容已变化，请重新选择楼层。');
    let count = 0;
    for (let offset = 0; offset < targets.length;) {
        const now = host.context();
        if (now.chat !== origin.chat || now.chatId !== origin.chatId || now.groupId !== origin.groupId || now.characterId !== origin.characterId) {
            throw new Error(`聊天已切换，批量操作停止（已处理 ${count} 条）。`);
        }
        let end = offset;
        while (end + 1 < targets.length && targets[end + 1].index === targets[end].index + 1) end++;
        const group = targets.slice(offset, end + 1);
        if (group.some(({ index, message }) => now.chat[index] !== message)) throw new Error(`聊天内容已变化，已停止（已处理 ${count} 条）。`);
        for (const { index, message } of group) {
            message.extra ??= {};
            message.extra.fastFloor = { ...message.extra.fastFloor, hiddenByPlugin: hidden };
            host.syncSwipe(index);
        }
        // Native helper updates is_system, rendered message attributes, and saves.
        await host.hideRange(group[0].index, group.at(-1).index, !hidden);
        count += group.length;
        offset = end + 1;
    }
    return count;
}
