# MIDI 步进音序器

基于 **TypeScript + Svelte** 的本地步进音序器：1～8 条音轨、每轨 1～64 步，每步可编辑**音高、力度、门长**，通过 **Web MIDI** 输出到本地设备。

## 功能

- 1～8 轨步进网格，每轨独立步数（1～64）与 MIDI 通道，可静音、增删
- 每步参数：音高（0–127，带音名显示）、力度（1–127）、门长（步长的 5%–100%）
- 播放 / 暂停 / 停止，20–300 BPM 实时变速
- 输出设备下拉选择；设备热插拔自动更新，断开的设备会标注并触发清理
- **无 Web MIDI 或未授权时**：乐谱编辑完全可用，播放按钮禁用——绝不假装在播放

## 快速开始（Docker）

```bash
docker compose config --quiet   # 校验 compose 配置
docker compose build            # 构建镜像
docker compose run --rm verify  # 一次性验收：类型检查 + 全部测试 + 生产构建
docker compose up web           # 开发服务器：http://localhost:5173
```

`verify` 服务以退出码报告结果：0 表示类型检查、31 项测试与生产构建全部通过。

## 本地开发

```bash
npm ci
npm run dev        # 开发服务器
npm test           # 单元 + 页面测试（无需 MIDI 硬件）
npm run check      # svelte-check 类型检查
npm run build      # 生产构建
npm run verify     # 上述三者依次执行（与 Docker verify 相同）
```

浏览器需支持 Web MIDI（Chrome / Edge）才能真正发声；其他浏览器可正常编辑乐谱。

## 架构

```
src/lib/sequencer/
  types.ts      乐谱模型（Pattern/Track/Step）与约束（1–8 轨、1–64 步）
  clock.ts      可替换时钟：BrowserClock（生产）/ ManualClock（测试）
  midi.ts       MIDI 消息构造函数（noteOn/noteOff/…）
  output.ts     输出适配器：Web MIDI 端口 / 测试记录适配器
  scheduler.ts  前瞻调度器（核心）
  devices.ts    Web MIDI 访问、设备列表、热插拔跟踪
src/lib/controller.ts  控制器：连接调度器、设备管理器与 Svelte stores
src/lib/components/    Transport / TrackGrid / StepEditor
```

### 前瞻调度

节拍**不**依赖每步一个定时器。调度器每 25ms 运行一次 tick：

1. **排程**：把未来 120ms（前瞻窗口）内到期的步展开成 note-on / note-off 事件，进入待发送队列；
2. **派发**：把队列中已到期的事件立即发给输出适配器。

因此节拍由时钟时间轴维持，单个定时器的迟到只会让它补做工作，不会累积误差。若主线程长时间停滞（如切后台），超过 240ms 的过期步会被跳过而不是补发，避免"追赶风暴"。

### 节奏更改的语义

`setTempo` 只影响**尚未送出**的步：队列中未派发的 note-on 会被丢弃，并从最近一个已到达的步边界按新节奏重新排程；已经在发声的音符保留其原定 note-off 时刻，历史消息绝不改写。

### 队列与发声音符的清理

暂停、停止、切换输出设备、设备断开，都执行同一套清理：

- 丢弃所有已排队但未送出的消息；
- 对每个**仍在发声**的音符立即补发 note-off（切设备时发到**旧**设备）——不会卡音；
- 队列中的事件要么完整派发、要么整体取消，同一事件只会派发一次——不会重复发音。

重新触发同一音符时，前一个实例的 note-off 会被钳制到新 note-on 的时刻，避免同音重叠。

### 可测试性

调度器只依赖 `Clock` 与 `MidiOutputAdapter` 两个接口：

- `ManualClock` 让测试手动推进时间，可精确模拟**迟到回调**（计时器回调观察到跳跃后的真实时间）、**停止边界**（到期但未派发的步被取消）、**重复点击**（任意 play/stop 序列后至多一个定时器、无重复音符）；
- `RecordingOutputAdapter` 记录每条消息及其时间戳，断言无需真实硬件；
- `FakeMidiAccess`（`tests/fakeMidi.ts`）模拟设备**热插拔**与断开；
- 页面测试在 jsdom 中渲染完整应用（无 `navigator.requestMIDIAccess`），验证"可编辑但不假装播放"。

## 测试

`npm test`（Vitest）共 31 项：

- `tests/scheduler.test.ts` — 前瞻排程、变速重排、停止/暂停清理、迟到回调、重复点击、设备切换与断开、门长、多轨独立循环、重触发保护
- `tests/devices.test.ts` — 设备列表、热插拔、断开清理、切换输出、无 MIDI 时拒绝播放
- `tests/app.test.ts` — 无 MIDI 硬件的页面级测试：编辑、增删轨、步数变更、播放禁用

## 验收

```bash
docker compose config --quiet
docker compose build
docker compose run --rm verify
```
