# 语音测试计划 —— 用你自己的声音测试每个功能

这是一份**亲自开口**的测试计划。你逐条把每句话念出来，听 Max 的回答，并查看
HUD。它覆盖的内容与 vitest 单元测试套件一致，但全部通过**豆包实时语音**用你真实
的声音来驱动。

> **Mock 模拟服务无法用于本测试。** Mock 会无视你说了什么、只回放预设台词，你的
> 麦克风根本不会被采集。真正的 ASR（听懂你实际说的话）只在 `VOICE_PROVIDER=doubao`
> 时才会发生。因此整份计划都必须使用实时语音服务。

## 一次性准备

```bash
# 中继机上的 .env：
#   VOICE_PROVIDER=doubao
#   DOUBAO_API_KEY=...            （或 DOUBAO_APP_ID + DOUBAO_APP_KEY + DOUBAO_ACCESS_KEY）
#   AGENT_WAKE_WORD=on            # 默认开启；唤醒词测试需要它
npm run dev:server                 # 在 :8787 启动中继
```

然后让客户端连接到 `ws://localhost:8787/agent`（网页端 `npm run dev:client`，或
iOS / Android App）。授予麦克风权限。打开隐藏的开发者面板（长按 Max logo），这样
说话时就能实时看到原始事件流和 session.memory。

开始前确认：`session.started` 显示 `provider: "doubao"`、`mode: "live"`、
`capabilities.synthesizedAudio: true`。如果显示 `mock`，说明 `.env` 没加载——
先修好，否则后面所有测试都无效。

## 如何看每一步

每一步对应一句话。格式：

> **说：** `……` —— **预期：** Max 会说什么 / HUD 显示什么 —— **通过条件：**
> 能证明它生效的那一个要点。

自然地说话即可，ASR 能容忍轻微的听错。每句话尽量简短。除非某一步明确要求重启会话，
否则步骤之间不要重启——多个测试依赖 12 秒跟读窗口和会话记忆跨步骤延续。

---

## A. 唤醒词 "Max"（4 步，约 1 分钟）

测试 `shared/wake.ts` —— 唤名门控、跟读窗口、无名抑制。

> **A1. 说：** `今天天气怎么样`（不带名字）
> **预期：** Max 保持沉默。没有 agent 转写行，没有 TTS。
> **通过条件：** 转写日志里看不到 agent 的内容。（你的 rider 行可能会短暂出现后
> 被丢弃。）

> **A2. 说：** `Max，今天天气怎么样`
> **预期：** Max 回答天气；状态翻到 `speaking`。
> **通过条件：** 出现一条 `agent` 转写行 **且** 你听到了 TTS。

> **A3. 12 秒内说：** `前面路况呢`（不带名字）
> **预期：** Max 仍然回答——跟读窗口还开着。
> **通过条件：** 不带名字 Max 也回复。证明 12 秒窗口生效。

> **A4. 安静等待 15 秒，再说：** `前面路况呢`（不带名字）
> **预期：** Max 再次沉默——窗口已关闭。
> **通过条件：** 没有回复。（如果 Max 仍回复，说明跟读窗口计时器坏了。）

可选开关检查：设置 `AGENT_WAKE_WORD=off`，重启中继，说 `今天天气怎么样`（不带
名字）→ Max 此时会回答每一句话。

---

## B. 语言检测 + 语言规则（3 步）

测试 `shared/language.ts` 以及 `server/providers/doubao.ts` 中"中文优先、英文其次、
其余拒绝"的提示词规则。

> **B1. 说：** `Max，前面路况怎么样`
> **预期：** Max 用**中文**回复；转写标签 `zh`；中文音色。
> **通过条件：** 回复是中文，且转写显示 `zh`。

> **B2. 说：** `Max, switch to English. How's the weather ahead?`
> **预期：** Max 用**英文**回复；转写标签 `en`。
> **通过条件：** 回复是英文，且转写显示 `en`。

> **B3. 说：** `マックス、天気はどう？`（日语）
> **预期：** Max 用中文回复：`我只支持中文和 English`（简短拒绝）。
> **通过条件：** Max **不**说日语，并给出那句拒绝语。

---

## C. 音色选择（1 步）

测试 `doubaoSpeaker` + "同一个 Max 角色"规则。

> **C1. 在界面切换到 男声，然后说：** `Max，你好`
> **预期：** Max 用男声回复，Max 人设/语言不变。
> **通过条件：** 音色明显是男声，且 Max 仍自称 Max（不是另一个角色）。切回女声
> 确认反向也成立。

---

## D. 天气问答（1 步）

用真实 Open-Meteo 数据端到端测试 `server/weather.ts`（需要定位权限，或设置
`DEFAULT_RIDER_LAT`/`DEFAULT_RIDER_LON`）。

> **D1. 说：** `Max，前面天气怎么样`
> **预期：** Max 的口头回答与 `实时天气` 卡片一致——天气描述、温度、风速、风险
> 与骑行建议。
> **通过条件：** Max 说的和卡片相符（风险等级一致、温度大致相同）。如果卡片是
> 空的，说明没设置定位——先修好，否则这个测试没有意义。

---

## E. 会话记忆 —— 目的地（2 步 + 1 个反例）

测试 `updateSessionMemory` / `inferDestination`（要求带目的地的措辞；光秃秃的
不定式**不得**被当作目的地）。

> **E1. 说：** `Max，导航去加油站`
> **预期：** Max 确认导航去加油站；开发者面板的 `session.memory` 事件显示
> `destination: "加油站"`。
> **通过条件：** `session.memory.destination` 被填充。

> **E2. 说：** `Max，还有多远`
> **预期：** Max 提到加油站（它记住了目的地）。
> **通过条件：** Max 的回答提到目的地，而不是泛泛而谈。

> **E3（反例）。说：** `Max，我想骑快一点`
> **预期：** Max 回答骑行相关——但 `session.memory.destination` 保持为空
> （光秃秃的"骑"不得被当作目的地）。
> **通过条件：** `destination` **没有**被设成 "ride" / "骑"。

---

## F. 会话记忆 —— 紧急升级（1 步）

测试 `inferIntent`（EMERGENCY_PATTERN）→ `responseModeForRide` → 紧急人设与安全
规则。

> **F1. 说：** `Max，我摔车了，需要帮助`
> **预期：** `session.memory.lastIntent` 变为 `emergency`，`responseMode` 变为
> `emergency`；Max 切到紧急人设——简短、安全优先、提到 `生命安全` / 靠边停车 /
> 求救。
> **通过条件：** intent/memory 更新显示 emergency **且** Max 的语气是紧急的，
> 不是闲聊。

---

## G. ADAS 主动安全告警 + 抢话打断（2 步）

测试 `shared/adas.ts` + `server/hazard-injector.ts`。实时路径上**只在 `ADAS`
场景**才会触发。

> **G1. 选择 `ADAS` 场景，开启免提，然后不停说话让 Max 话说到一半。等约 5 秒。**
> **预期：** 触发一个打断式 `hazard.alert`——骑行脉冲跳到 caution/critical，Max
> 当前的话被**打断**（抢话），并播报某条方向告警，例如 `注意，后方车辆高速接近。
保持车道，握稳车把，不要急刹。`
> **通过条件：** (1) 告警打断了语音；(2) Max 只把告警**读一遍**（没有重复 TTS——
> 转写行只用于显示）；(3) HUD 风险等级上升。

> **G2. 在 Max 正在说话时说：** `Max，停`
> **预期：** Max 立刻停下（骑手抢话）。
> **通过条件：** 你一开口 TTS 就中断。

---

## H. 身份与归属提示词（2 步）

测试 `buildIdentityPrompt` —— 开发者是 neueHCT，**绝不**是 ByteDance/Doubao。

> **H1. 说：** `Max，你是哪家公司开发的`
> **预期：** Max 说是由 Horizon Continental Technology / neueHCT（李彪 / Stone Li）
> 开发的。**不得**说 ByteDance 或 Doubao。
> **通过条件：** 提到 neueHCT，且没有提到 ByteDance/Doubao。

> **H2. 说：** `Max，你是豆包吗`
> **预期：** Max 否认自己是 Doubao/ByteDance（提示词里有明确禁止）。
> **通过条件：** Max 没有自称是 Doubao。

---

## I. 骑行情报 / HUD 融合（观察，1 步）

测试 `shared/ride.ts` —— 场景 → 风险等级 → `态势摘要` 卡片。不靠声音驱动，靠
场景选择器切换、你来观察。

> **I1. 按顺序切换场景：** `通勤` → `横风` → `紧急`。
> **预期：** 骑行脉冲风险依次上升 normal → caution → critical，`态势摘要`
> 卡片的骑行建议随之变化
> （`保持节奏…` → `放缓一点…` → `优先靠边…`）。
> **通过条件：** 三档等级和建议按顺序全部出现。

> **回归 bug 复查：** 停在 `横风`，等一个风险**低于**当前 hazard 的 `weather`
> 事件。骑行脉冲的风险**不得**因为天气事件而下降（它由 `ride.context` 管理）；
> 只有 `态势摘要` 卡片会反映更低的天气风险。这正是我们修的棘轮 bug——确认风险
> 不会因天气而向下回退。

---

## 无法用语音测试 —— 靠观察确认

这些功能没有对应的话术；在上述会话过程中在开发者面板 / 中继日志里各查一次即可。

| 功能                                           | 在哪里看                           | 确认什么                                                                          |
| ---------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| 服务能力 `shared/agent.ts`                     | 开发者面板 → `session.started`     | 豆包下 `capabilities.synthesizedAudio`/`serverVad` 为 true                        |
| 豆包帧协议 `doubao.ts`                         | 你说话时的中继日志                 | 出现 JSON ASR 帧 + 原始 PCM 音频帧，无解析错误                                    |
| 中继鉴权与限流 `server/auth.ts`                | 用原始 `ws` 客户端重连             | 按配置拒绝 token/来源/频率                                                        |
| WebSocket 中继生命周期 `session-controller.ts` | 开发者面板原始流                   | `connection`→`session.started`→`ride.context`→`session.memory`→`weather`→轮次循环 |
| 客户端事件校验 `session-controller.ts`         | 用原始客户端发非法 `session.start` | 中继拒绝 "Invalid sampleRate" 等                                                  |
| 音频包指标 `shared/audio.ts`                   | 说话时网页端的音频 HUD             | 发送 FPS 跟随发送速率；负载下丢帧递增                                             |
| Mock 场景巡游 `mock.ts`                        | 实时路径上不适用                   | 用 `VOICE_PROVIDER=mock` 重跑可见引导巡游                                         |

---

## 一页通关表（打印这份）

| #   | 说 / 做                      | 通过条件                              |
| --- | ---------------------------- | ------------------------------------- |
| A1  | `今天天气怎么样`（不带名字） | Max 沉默                              |
| A2  | `Max，今天天气怎么样`        | Max 回答 + 有 TTS                     |
| A3  | （≤12 秒）`前面路况呢`       | Max 回答（跟读窗口）                  |
| A4  | （>12 秒）`前面路况呢`       | Max 沉默（窗口已关闭）                |
| B1  | `Max，前面路况怎么样`        | 中文回复，标签 `zh`                   |
| B2  | `Max, switch to English…`    | 英文回复，标签 `en`                   |
| B3  | `マックス、天気はどう？`     | 中文拒绝 `我只支持中文和 English`     |
| C1  | 切男声，`Max，你好`          | 男声、仍是 Max                        |
| D1  | `Max，前面天气怎么样`        | 口头回答与实时天气卡片一致            |
| E1  | `Max，导航去加油站`          | `session.memory.destination = 加油站` |
| E2  | `Max，还有多远`              | Max 提到目的地                        |
| E3  | `Max，我想骑快一点`          | `destination` 保持为空（不误捕）      |
| F1  | `Max，我摔车了，需要帮助`    | intent/memory → emergency，紧急人设   |
| G1  | ADAS 场景，说话，等约 5 秒   | 打断式告警，TTS 一次，风险上升        |
| G2  | Max 说话时 `Max，停`         | 语音立刻中断（抢话）                  |
| H1  | `Max，你是哪家公司开发的`    | 提到 neueHCT，不是 ByteDance/Doubao   |
| H2  | `Max，你是豆包吗`            | Max 否认是 Doubao                     |
| I1  | 切换 通勤→横风→紧急          | 风险 + 骑行建议依次升级三档           |
| I2  | 在横风，天气风险下降         | 骑行脉冲风险不因天气向下回退          |

A–I 全绿，加上观察表，就覆盖了 vitest 套件覆盖的每个功能——全部用你自己的声音
在实时 agent 上跑一遍。
