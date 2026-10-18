# PostgreSQL 持久化运行指南

阶段 4 将 PostgreSQL 放在 Memory Engine 的 Repository seam 后方。浏览器不加载数据库凭据，只能通过本地服务器的 `/api/memory/*` 端点访问持久化运行时。

## 初始化

```powershell
$env:DATABASE_URL = "postgresql://user:password@localhost:5432/sageflow"
npm run migrate:postgres
```

迁移程序按文件名顺序执行，每个文件使用独立事务，并将 SHA-256 校验值写入 `schema_migrations`。已执行的迁移被修改时，程序会拒绝继续运行。

## 启动持久化端点

```powershell
$env:DATABASE_URL = "postgresql://user:password@localhost:5432/sageflow"
$env:SAGEFLOW_API_TOKEN = "local-development-token"
npm start
```

可选地设置 `$env:SAGEFLOW_AUTO_MIGRATE = "1"`，允许本地服务器启动时执行未运行的迁移。默认关闭，避免意外修改数据库。

端点：

- `GET /api/memory/health`
- `POST /api/memory/observe`
- `POST /api/memory/recall`

写入和召回请求必须携带 `X-SageFlow-User-Id`；该值必须与请求体中的 `user_id` 一致。如果配置了 `SAGEFLOW_API_TOKEN`，还必须携带 `Authorization: Bearer <token>`。

这是本地原型鉴权，不是生产身份系统。生产部署必须由可信网关从登录身份注入用户标识，不能信任客户端自行声明的用户 ID。

## 数据与事务

- Observation Event 以 `(user_id, event_id)` 唯一并保持不可变；相同内容的重放会被识别为 duplicate，不会再次强化记忆，同 ID 不同内容会使事务失败。
- Memory、Mutation、Conflict、Edge、Pending Candidate 和 Recall Log 均以用户维度隔离。
- 一次 `observe()` 的事件、记忆、关系和变更记录在同一数据库事务内提交；任一步失败都会回滚。
- Recall Log 只保存命中的记忆 ID、排除原因和策略版本，不重复保存完整记忆正文。

## 真实数据库集成测试

```powershell
$env:SAGEFLOW_TEST_DATABASE_URL = "postgresql://user:password@localhost:5432/sageflow_test"
npm run test:postgres
```

测试会创建随机临时 schema，验证迁移、重启后召回、相同 Memory ID 的多用户隔离，然后删除该临时 schema。未设置测试数据库时，此项自动跳过。

## 阶段五检索索引

标准迁移 `004_retrieval_text_index.sql` 为英文/代码式词项建立 PostgreSQL 全文索引；中文查询仍由本地词项通道兜底。向量检索是可选功能：安装兼容的 pgvector 后，手动执行 [`db/optional/pgvector.sql`](../db/optional/pgvector.sql)，并在运行时传入有稳定 `version` 和 `embed(text)` 方法的 embedder。该 SQL 不属于自动迁移，未配置 embedder 时不会访问 `memory_embeddings`。更换模型版本需重建已有 embedding；目前是精确余弦扫描，没有 ANN 索引。

当前原型仍先按用户加载记忆，再执行权限/时间/范围过滤并把允许的 ID 传给数据库检索；这是安全优先的小规模实现，不是大用户记忆库的最终查询计划。真实部署应在数据库层下推硬过滤、批量回填 embedding，并补充 P95 时延和召回质量评测。
