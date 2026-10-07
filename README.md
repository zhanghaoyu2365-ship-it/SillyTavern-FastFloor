# Fast Floor / 极速刷楼

SillyTavern 极简高速自动刷楼扩展。

## 功能

- 指定要自动生成的楼层数。
- 使用隐藏提示词驱动下一层，默认是 `继续`。
- 隐藏提示词不会作为用户消息显示在聊天记录中。
- 每次只新增一条 AI 回复。
- 上一层生成完成后立即请求下一层，不设置额外等待时间。
- 支持随时停止。

## 手动安装

将整个 `SillyTavern-FastFloor` 文件夹放进当前用户的扩展目录：

`data/default-user/extensions/SillyTavern-FastFloor`

然后重启 SillyTavern 或刷新页面。

较旧版本如果仍使用旧式目录，则放到：

`public/scripts/extensions/third-party/SillyTavern-FastFloor`

进入 **Extensions / 扩展** 设置页，找到 **⚡ 极速刷楼**。

## 使用

1. 打开一个角色聊天或群聊。
2. 输入目标楼层数，例如 `50`。
3. 隐藏提示词保持 `继续`，或改成你自己的推进指令。
4. 点击 **开始**。
5. 要中途结束时点击 **停止**。正在生成的当前层会先完成，然后停止后续请求。

## 注意

“高速”指没有人为等待间隔；实际速度仍取决于当前模型、API、上下文长度、网络速度和最大回复长度。
