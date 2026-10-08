> Historical phase-one checkpoint. Current implementation and limits: [cloud-workspace-v2.md](cloud-workspace-v2.md). The remainder records the earlier release.

# Codia 云工作空间第一阶段

基线：BaiQiaochu/g-sap-ggow 07731c76a4d2dd8eb5db619c232225d4e8aa6ed2。直接修改原有工程，无远程推送或部署。

## 已实现
现有网页端 /mobile.html#cloud-workspace 集成云工作空间入口，沿用 web-auth 登录，支持创建空间、上传2MiB以内文本、不可变历史版本、expectedVersion冲突检测、持久任务、事件补拉及产物预览/下载。

元数据保存在服务端 GSAP_HOME/cloud-workspaces/metadata.db，对象保存在同目录objects。客户端不是权威数据源。工作空间按已认证userId/studioId隔离，所有文件/版本/任务路径重新授权；请求体身份不授权。ResourceIO通过resourceId=cloud-file:<fileId>接入，并按请求绑定身份，禁止无条件写入和任意路径。

后台任务是固定文档检查/摘录，不是大模型Agent。指定版本输入固定，客户端关闭或登出不取消任务。任务领取有30秒租约和attempt fencing，过期重试最多3次；任务/产物/outbox事务提交，重复requestKey返回同一任务。子进程只运行固定可信程序，不继承数据库或对象密钥；不声称是任意代码安全沙箱。

上传先staging，再对象写入读回校验，再CAS提交；未提交版本不可见。进程崩溃残留staging有5分钟宽限，随后回收状态，但不删除对象；宽限内同名初次重试可能409。保留旧版本及孤儿对象，本阶段没有配额/清理/备份容灾。

## 明确未完成
运行仍是SQLite+本地对象，UI标明开发验证/本地持久化。S3 SigV4适配器已实现但未连接真实服务；PostgreSQL只有事务适配器和未执行RLS目标schema，不是完整repository。没有建云项目/bucket/密钥、改变权限或上线。生产PostgreSQL仓库、真正隔离Agent执行器、存量会话/工作流迁移、团队成员、HTTPS/完整生产身份、备份还原和多租户全站放行仍待实现。旧项目其他认证/安全问题不因本模块自动解决。

## 验证与恢复说明
本交付在执行环境重启后从保留的源码工具调用内容恢复，必须以包内verification的新日志为准；此前测试结果不自动证明恢复后代码。相关测试涵盖授权、版本CAS、幂等、租约恢复、产物hash、S3签名/PG事务契约及React交互。真正全应用API冒烟脚本为scripts/smoke-cloud-workspace.mjs，使用隔离合成数据目录，正常web-auth登录且不输出密钥。

运行：GSAP_DEV_HOME=/tmp/codia-smoke GSAP_DEV_WEB_CLIENT_PORT=5175 GSAP_PORT=14505 node scripts/dev-web.js；进入/mobile.html#cloud-workspace。另一个终端设置GSAP_SMOKE_HOME=/tmp/codia-smoke GSAP_SMOKE_FRONTEND=http://127.0.0.1:5175运行node scripts/smoke-cloud-workspace.mjs。正常关闭重启同数据目录后，运行同脚本--verify-persisted验证文件/任务/产物hash。不要指向生产数据。

真实浏览器先前被环境扩展以ERR_BLOCKED_BY_CLIENT阻塞；恢复后须重新取得截图。API/组件测试截图不等于UI视觉验收通过。没有宣称全仓库所有测试通过。

## 恢复后最终验收（2026-10-07 UTC）

- 8个相关测试文件、106项测试重新通过（含首次身份初始化及损坏注册表拒绝回归）
- 真实Codia全应用API冒烟10/10、干净首次启动后的完整进程重启2/2通过
- renderer+test与Node全量TypeScript检查通过；renderer和theme生产构建通过
- 聚焦ESLint无错误，保留10条显式any类警告
- 服务已正常关闭；不承诺云电脑常驻运行
- 恢复后的便携server二进制包未重新验收，本包交付源码补丁，不是已验证的生产安装包
- 正常云浏览器对原开发地址重试仍报ERR_BLOCKED_BY_CLIENT；提供真实API终端结果和浏览器阻塞截图，没有把它们冒称UI验收成功
