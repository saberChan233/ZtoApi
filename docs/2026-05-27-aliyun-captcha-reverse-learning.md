# Aliyun CAPTCHA 匿名链路修复复盘（2026-05-27）

## 1. 背景

本次问题的目标不是“单独把验证码接口打通”，而是：

- **匿名状态**
- **纯代码**
- **端到端多轮对话**
- **不报 CAPTCHA 错误**

最终结果已验证：

- auto-captcha 在匿名状态可正常运行
- worker 可返回真实 `captcha_verify_param`
- 匿名多轮对话已跑通

---

## 2. 这次修复真正解决了什么

### 2.1 当前稳定链路

当前稳定链路不是“预置本地固定 bundle + 猜参数”，而是：

1. 使用真实 `AliyunCaptcha.js` loader
2. **loader-only** 启动
3. 运行时按真实返回路径动态加载 FeiLin / dynamicJS
4. 缺失本地映射时，**自动抓取当前 live bundle**
5. 在真实 live 环境下完成 `VerifyCaptchaV3`
6. 从成功响应中提取 `securityToken`
7. 合成 `captcha_verify_param`
8. 注入匿名上游请求体后重试

### 2.2 当前关键实现点

- `tools/probe_feilin_runtime.js`
  - 支持 `scriptFetchMode=auto`
  - 支持运行时自动下载并执行 loader 追加的脚本
- `tools/browserless_aliyun_captcha_solver.js`
  - 支持 `loaderOnly`
  - `loaderOnly` 时不再错误 ensure feilin/dynamic
- `tools/aliyun_bundle_bootstrap.js`
  - 避免同一路径重复覆盖
- `tools/pure_code_captcha_worker.js`
  - 默认支持 `loader-only + auto-fetch`
  - 集成独立 live probe 成功链路
- `main.ts`
  - auto-captcha 模型匹配范围修正，真实使用的模型也会触发

---

## 3. 这次最关键的经验

## 3.1 不要过早猜 token 某一段，先确认“运行家族”是否一致

之前大量时间浪费在：

- second / third / fourth segment 猜测
- 单字段替换实验
- 外部重放局部参数

但事实证明，**更上游的问题更致命**：

- bundle family 不一致
- loader 执行顺序不一致
- 本地文件被错误覆盖

结论：

> 在 Aliyun CAPTCHA 逆向里，**先确认 loader / FeiLin / dynamicJS 的真实家族与加载顺序**，再看 token/data 差异。

---

## 3.2 `verify second` 已有确定结论，不要重复浪费时间

已确认：

- `VerifyCaptchaV3` token second
- 来自 `Log1.responseJson.ResultObject.DeviceConfig.sessionId`
- **不是** `InitCaptchaV3.responseJson.DeviceConfig.sessionId`

结论：

> 后续如果再次碰到 F001，默认不要再从 second 入手，除非有新的证据推翻这个结论。

---

## 3.3 loader-only 比“预加载 bundle”更接近真实浏览器

过去的问题之一是：

- 先把 feilin / pe / loader 一起预加载到 VM

但真实浏览器路径是：

1. 先跑 loader
2. init / log1 返回当前环境对应信息
3. 再由 loader append 后续脚本

结论：

> 后续研究的默认起点应该是 **loader-only**，而不是“三件套静态预塞”。

---

## 3.4 live 环境下 bundle 会漂移，不能写死

这次已经明确看到：

- 同一条链路，不同时间会拿到不同的
  - `feilin056 / feilin057 ...`
  - `pe.063 / pe.093 / pe.051 ...`

结论：

> **不能把某个 pe / feilin 版本当成永久正确答案。**
> 正确策略是：让 loader 跑起来，然后按 live 真实返回自动跟进。

---

## 3.5 文件污染会把所有后续实验都带偏

这次有一个非常致命但隐蔽的问题：

- `/tmp/AliyunCaptcha.js` 被错误覆盖成了 **FeiLin 文件**

直接后果：

- `initAliyunCaptcha` 消失
- `scriptLoadLogs=[]`
- `xhrActions=[]`
- 后续所有“worker 失败”“链路没进验证码”其实都建立在错误前提上

结论：

> 每次实验前，必须先验证：

- loader 文件是否真的是 loader
- feilin / dynamic / loader 路径是否串了
- 是否有同路径重复写入

---

## 4. 本次逆向 / 修复过程里的注意点

## 4.1 必做检查清单

每次出问题先做下面这组检查：

### A. 先看 loader 是否正常

- `AliyunCaptcha.js` 是否包含 `initAliyunCaptcha`
- 独立 probe 里：
  - `evalOk`
  - `initAliyunCaptchaType`
  - `scriptLoadLogs`

如果这里已经不对，后面所有 token 分析都不可信。

### B. 再看 live 脚本实际加载了什么

重点看：

- `scriptLoadLogs`
- 追加的 FeiLin URL
- 追加的 dynamicJS URL
- `InitCaptchaV3.responseJson.StaticPath`
- `DeviceConfig.version`

### C. 再看 verify 是否真实发出

重点看：

- `xhrLog` 是否出现 `VerifyCaptchaV3`
- 返回是：
  - `T001`
  - `F001`
  - `F008`
  - 还是根本没发出去

### D. 最后才看 payload 差异

重点看：

- `CaptchaVerifyParam.deviceToken`
- `CaptchaVerifyParam.data`
- `securityToken`

---

## 4.2 `upLang` 报错不是主因

日志里会经常出现：

- `upLang传入参数类型不合法`

这次实测证明，它**不阻止成功链路**。

结论：

> 它是噪音，不是这次阻塞 T001 的主因。除非后续出现明确相关证据，否则不要把它当核心方向。

---

## 4.3 F001 与 F008 的排查优先级不同

### F001
通常更值得优先怀疑：

- bundle family / loader 执行链不一致
- token third / data 与当前 live runtime 不一致
- session/runtime family 混线

### F008
更像是：

- payload 某些段被替换后结构不合法
- verify 请求形态异常
- 非真实链路拼接出来的错误参数

结论：

> F001 优先看“运行态是否真实一致”，F008 优先看“请求形态是否被你改坏了”。

---

## 5. 如果后续服务端改了，应该怎么继续推进

## 5.1 第一原则：不要从旧结论硬推，要先重新采样 live

服务端升级后，第一步不是改代码，而是重新跑：

1. 独立 loader-only live probe
2. 记录：
   - scriptLoadLogs
   - StaticPath
   - DeviceConfig.version
   - VerifyCode

只有先拿到新的 live 事实，后面才有意义。

---

## 5.2 推荐的排查顺序

### 第 1 步：确认是否还能拿到真实 live bundle

看：

- loader 是否还能 append 脚本
- auto-fetch 是否还能下载脚本
- 是否出现新的 CDN 路径或版本格式

如果 loader 机制都变了，先修脚本加载层。

### 第 2 步：确认是否还能真实发出 verify

看：

- `VerifyCaptchaV3` 是否还存在
- Action 名称是否变化
- 返回结构是否变化

如果 action / response schema 改了，先修解析与提取逻辑。

### 第 3 步：确认成功信号是否变化

现在默认成功信号是：

- `VerifyCode = T001`
- `VerifyResult = true`
- 返回 `securityToken`

如果以后字段名或成功码改了：

- 先更新 probe 的成功判定逻辑
- 再更新 worker 的 `captcha_verify_param` 合成逻辑

### 第 4 步：最后才看逆向细节

只有在：

- loader 正常
- bundle 正常
- verify 正常发出
- 但结果失败

才继续细看：

- token third
- data
- DeviceConfig 映射

---

## 5.3 推荐保留的研究工具

后续继续研究时，优先用这些：

- `tools/aliyun_loader_family_probe.js`
  - 当前最重要的 live 真值探针
- `tools/probe_feilin_runtime.js`
  - VM 运行时主分析器
- `tools/pure_code_captcha_worker.js`
  - 集成链路入口
- `tools/browserless_aliyun_captcha_solver.js`
  - 求解主流程

建议默认只做：

- 单 case
- 单进程
- `--max-old-space-size=512`

避免重新进入 OOM 和多实验并发泥潭。

---

## 6. 本次修复中最值得长期保留的做法

1. **先做独立 probe，再做 worker 集成**
   - 先证明验证码链路本身成功
   - 再接回业务链路

2. **用 live 真实返回驱动 bundle 选择**
   - 不再依赖固定本地版本

3. **把失败快照写到 `.codex/captcha-failures/`**
   - 方便复盘“到底是没发请求，还是发了但失败”

4. **把 worker 内存上限固定住**
   - 防止调试阶段再次把机器打爆

5. **模型匹配规则要和真实上游模型名一致**
   - 否则验证码链路明明好了，业务层却根本不会触发

---

## 7. 本次修复的最终验收证据

### 独立 probe

已验证：

- `VerifyCode = T001`
- `VerifyResult = true`
- 可提取真实 `securityToken`

### worker

已验证：

- 返回 `source = pure-code-worker-live-verify`
- 返回真实 `captcha_verify_param`

### 匿名多轮对话

已验证：

- 匿名本地接口触发 auto-captcha
- 请求体成功注入 `captcha_verify_param`
- 连续多轮上游返回 `200`
- 无 CAPTCHA 报错

---

## 8. 后续维护建议

如果以后再出 CAPTCHA 故障，默认按下面顺序处理：

1. 先跑 `tools/aliyun_loader_family_probe.js`
2. 看 loader / scriptLoad / StaticPath / VerifyCode
3. 确认当前 live bundle 家族
4. 确认 worker 是否仍走 loader-only live 路径
5. 确认 `main.ts` 的模型匹配和注入条件没有漂移
6. 最后才做 token/data 级逆向

一句话总结：

> **Aliyun CAPTCHA 这类问题，最怕的不是“不会逆向”，而是“在错误运行态上做了大量精细分析”。**
> 先确认真实运行态，再做细节逆向，效率会高很多。
