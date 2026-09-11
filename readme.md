当前工程采用TypeScript实现
解析java代码，构建以下关系：
1、类方法与类方法、类属性之间的调用关系
2、类与类之间的关系（继承、实现）
3、解析类的元信息(名称、路径、注解信息、注释信息)
4、解析方法、属性的元信息（名称、注解信息、注释信息）

## 运行

```bash
npm install
npm run build
npm start -- --input <dir|file> [--output <out.json>] [--annotations Override,Service] [--page-size 50] [--config codeparse.config.json]
```

## 注解出页配置

可以为指定的注解名单独生成一个分页明细页。配置方式二选一（命令行优先于配置文件）：

**1）配置文件 `codeparse.config.json`**（放在运行目录下，`--config` 可指定其它路径）：

```json
{
  "annotations": ["Override", "Service", "org.springframework.stereotype.Repository"],
  "pageSize": 50
}
```

**2）命令行参数**：

```bash
npm start -- --input ./src --annotations Override,Service --page-size 100
```

- `annotations`：需要单独出页的注解名，支持**简单名**（`Override`）或**全限定名**（`org.springframework.stereotype.Service`）。
  简单名会同时匹配源码中写作全限定形式的同名注解，反之亦然。
- `pageSize`：详情页每页条数，默认 50。
- 未在工程中匹配到任何引用的注解名会打印提示并跳过出页，不产生空页面。

其它可选配置项：`jsonIndent`（输出 JSON 缩进，默认 2，设 0 为紧凑格式）、`skipJson`（为 true 时跳过 result.json，只出 HTML）。

产物命名：`<输出基名>.anno.<注解简单名>.html`，例如 `result.anno.Override.html`。
页面内提供：引用总数/涉及类数/涉及文件数统计、按标注位置（类/字段/方法/构造器）过滤、
关键字搜索（目标、类、文件、注解参数）、分页（首页/上一页/下一页/末页、页码跳转、每页条数切换）。

首页 `<输出基名>.index.html` 会为每个注解自动追加一张入口卡片；
概览报告的「注解引用次数排行」中，已出页的注解名会渲染为可点击链接。

## 超大工程

所有 JSON 与内嵌 JSON 的 HTML 都改为**流式分片写出**（`src/utils/stream-writer.ts`），
不再一次性 `JSON.stringify`，因此不会触发 `RangeError: Invalid string length`。

若数据量进一步增大到内存吃紧，可叠加以下手段：

```bash
# 1) 紧凑 JSON，体积约为缩进格式的 60%
npm start -- --input ./big --json-indent 0

# 2) 不需要 result.json 时直接跳过（HTML 报告仍完整）
npm start -- --input ./big --no-json

# 3) 放宽 Node 堆上限
node --max-old-space-size=8192 node_modules/ts-node/dist/bin.js src/index.ts --input ./big
```
