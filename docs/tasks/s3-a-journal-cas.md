# S3-A 任务卡：单 writer journal 与 CAS

## Goal

建立 `packages/singularity/runtime` 的真实文件存储：一个 domain journal、一个 command writer、一个 CAS。验证原子 CAS 写入、fact append/fsync、串行 command 幂等、torn-tail 恢复和 replay，不实现第二写入路径或存储层业务 guard。

## Spec refs

- `docs/framework.md` §10、§11、§19.1 及获批 amendment K1–K3
- `docs/build-plan.md` S3

## 允许修改范围

- 新 runtime package 的存储、command service、package tests 与必要构建配置
- 根 tsconfig references、lockfile、验证文档

## 非目标

- 不实现 Agent loop、workspace/verifier、业务 reducer 第二份、第二 writer/fold/wake/registry/transcript。
- 不用内存 boolean 代替持久幂等，不用跳过损坏行或破坏性清理制造恢复成功。
- 不宣称 C-02/C-03/C-12 或真实模型场景已验证。

## Done when

- CAS 先临时写入、校验 object digest、原子 rename、fsync；引用前可重读验证。
- 一个 project process 内 command writer 串行分配 seq/prev/digest，fact append+fsync 后才返回成功。
- 同 commandId+commandDigest 返回原 fact 且不追加；不同 digest 返回 IDEMPOTENCY_CONFLICT；重启后仍成立。
- 仅 EOF 未终止 tail 可截去，中间损坏拒绝启动；replay 与 protocol fold 一致。
- 根 `pnpm verify` 全通过，真实文件证据与未验证项明确记录。

## 检查命令

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

## 失败证据与运行记录

待首个复现和实现后填写实际命令、结果与未验证项。
