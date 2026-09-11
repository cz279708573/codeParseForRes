# 项目长期约定

- 报告职责分工：概览报告（`<base>.html`）= 纯统计看板，不画网络图；`graph.html` = 全量网络图与节点详情；`trace.html` = 方法链路追踪；`<base>.anno.<Name>.html` = 配置注解的分页明细。
- 用户可配置项统一放在运行目录的 `codeparse.config.json`，并同时提供 CLI 覆盖（`--annotations` / `--page-size` / `--config`），CLI 优先。
- 大结果一律走 `src/utils/stream-writer.ts` 的分片/流式写出，禁止对 ParseResult、Graph 或内嵌 HTML 的 JSON 做一次性 `JSON.stringify`（会触发 RangeError: Invalid string length）。
- 已知解析器缺口：`annotation_type_declaration`（`@interface` 声明）未被 `JavaNodeType` 覆盖，导致注解类型声明上的元注解（如 `@Retention`/`@Target`）不计入统计。
