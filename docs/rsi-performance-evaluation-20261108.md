# 连续性能评分与 EDA 续测

日期：2026-11-08；协议 authority：framework amendment 028。

旧 Buckyball 实验使用根任务 verified fraction。两臂全通过后均为 1，评分没有上升空间，因而 `no-improvement` 是冻结规则下的正确结论。把同一套检查拆成更多项目仍可能满分；通过项目数量不能替代性能。旧实验不追溯改判，也不能把生成 token 下降换算成质量提升。

## 参考实现

研究了 [KernelBench score.py](https://github.com/ScalingIntelligence/KernelBench/blob/423217d9fda91e0c2d67e4a43bf62f96f6d104f1/src/kernelbench/score.py)、[eval.py](https://github.com/ScalingIntelligence/KernelBench/blob/423217d9fda91e0c2d67e4a43bf62f96f6d104f1/src/kernelbench/eval.py) 和 [timing.py](https://github.com/ScalingIntelligence/KernelBench/blob/423217d9fda91e0c2d67e4a43bf62f96f6d104f1/src/kernelbench/timing.py)，本地 checkout 为 `/home/ROXY/code/bb_work/research-kernelbench-20261108`，SHA `423217d9fda91e0c2d67e4a43bf62f96f6d104f1`。

它先验证正确性，再测 runtime；加速比为 baseline runtime / candidate runtime，并提供几何平均。其 `fastp` 另行统计超过给定加速阈值的题目比例，该比例仍有上界。不能把不同指标混为一个无限制分数。测量实现还使用 warmup、重复计时与 GPU 同步。本轮实际运行的是 EDA 工具，没有声称已跑通 CUDA KernelBench suite。

本项目采用同样的正确性前提和参考比值思想，但主聚合保留所有冻结案例和 trial：功能失败为 0，缺失或 invalid 证据不得填 0 或跳过；不采用只平均正确且变快样本的筛选。public cases 使用几何平均；独立 validation 只约束不回退，不贡献 public 收益。所有收益与成本分别报告。

## 接口与归属

领域准备时冻结性能目标、参考实现、测量条件、工具、正确性和评分公式。`domain.json` 的 `metric:{criterion,name,unit}` 选择 required criterion；冻结 shell check 声明 `checkOutput:"metric-json"`，宿主仅解析一条 `{name,unit,value}` JSON，使用既有 PublicMetric/PublicReceipt 绑定 CAS 输入输出。模型自报测量不能覆盖宿主 check；review 失败或 invalid 也不能被性能值放行。

协议/runtime 不包含 PPA 或 CUDA 算法。任务通过率比较仍适用于普通质量任务；性能任务选择通用连续比较器。分数要求有限正数，参考=1，无人工上限；public 相对增益 candidate/baseline−1 至少 1%，每个 case 和 validation 均不回退。生成 token 另报，性能任务不沿用旧的默认 2 倍 token 成本门槛，操作者总预算与截止正常执行。

## 公开 EDA 领域

独立领域和实验位于 `/home/ROXY/code/bb_work/performance-rsi-study-20261108/`。输入提供 serial popcount RTL，source W=16，public W=32/64，validation W=48。连续输入握手测量使用零、全一、one-hot 与固定 seed 随机向量；VCS 核对输出值、顺序、完成和无额外输出，再测周期、延迟和启动间隔。DC 在 SMIC180 SCC018UG UHD RVT ss 1.62V/125C CCS 库、20ns 时钟、输入/输出 delay 1ns、输出 load 0.02 下执行 compile，读取 mapped area、worst slack 和完整报告。

本轮自主选择的目标为：

```
score = (Aref / A)^0.25 * (Lref / L)^0.375 * (T / Tref)^0.375
```

A 为综合单元面积；L 为平均周期延迟乘固定时钟周期；T 为平均启动间隔与时钟周期乘积的倒数。正确、映射完成且 slack 非负是硬约束。默认活动率的 `report_power` 保留作估计，未计入分数；这不是 workload 活动标注功耗或布局布线后的完整 PPA。未来功耗需求必须冻结活动率、工具条件和功耗参考再加入函数。

零模型预检中，参考复测得 1；已知正确的并行实现四个宽度分别为 12.1782、17.9445、27.5425、23.0512。这只证明评测器对真实实现差异有连续响应，不构成 RSI 改进。原生 CAS-only verifier 进一步独立重测并行产物，收到分数 12.1782，完整 stderr 报告未截断。错误功能、时序违例、工具不可用分别测试；不根据退出码 0 就假定 DC 成功，解析错误和缺失测量不能成为有效性能数值。

新付费实验使用空 Method source → proposer/precheck → 两 public 与一个 validation、两臂各两次 fresh Task，总计划 13 个 root。它比较学习后的 Method 与同模型空 Method，两者均可自行优化；固定串行参考的分数 1 与 fresh 空 Method 的实际分数是不同概念。不预设 child 树，不保证一定 improved。仅三个参数宽度、公开可信本地环境和小样本重复，不能外推至一般芯片设计或自主多层 workflow。

## 证据状态

生产代码的 `pnpm verify` 已通过 456/456；具体新试验计划与结束结论见同目录 plan/result/report 和 docs/progress.md。真实试验结束后追加实测结论，启动不能算完成。
