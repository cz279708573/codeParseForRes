/**
 * AST 节点类型枚举。
 * 值与 tree-sitter-java 语法中的节点 type 字符串保持一致，
 * 故意使用字面量类型而非纯数字，便于与运行时 node.type 直接比对。
 */
export enum JavaNodeType {
  // 顶层声明
  Program = 'program',
  PackageDeclaration = 'package_declaration',
  ImportDeclaration = 'import_declaration',
  ClassDeclaration = 'class_declaration',
  InterfaceDeclaration = 'interface_declaration',
  EnumDeclaration = 'enum_declaration',
  RecordDeclaration = 'record_declaration',
  // 声明体
  ClassBody = 'class_body',
  InterfaceBody = 'interface_body',
  EnumBody = 'enum_body',
  // 成员
  MethodDeclaration = 'method_declaration',
  ConstructorDeclaration = 'constructor_declaration',
  FieldDeclaration = 'field_declaration',
  ConstantDeclaration = 'constant_declaration',
  VariableDeclarator = 'variable_declarator',
  EnumConstant = 'enum_constant',
  // 修饰与元信息
  Modifiers = 'modifiers',
  Annotation = 'annotation',
  MarkerAnnotation = 'marker_annotation',
  Identifier = 'identifier',
  TypeIdentifier = 'type_identifier',
  ScopedIdentifier = 'scoped_identifier',
  FormalParameters = 'formal_parameters',
  FormalParameter = 'formal_parameter',
  Throws = 'throws',
  Block = 'block',
  // 继承
  Superclass = 'superclass',
  SuperInterfaces = 'super_interfaces',
  TypeList = 'type_list',
  // 注释
  Comment = 'comment',
  LineComment = 'line_comment',
  BlockComment = 'block_comment',
  // 调用与访问（关系构建用）
  MethodInvocation = 'method_invocation',
  FieldAccess = 'field_access',
  This = 'this',
  Super = 'super',
  ObjectCreation = 'object_creation_expression',
  ArgumentList = 'argument_list',
}

/** 注解信息 */
export interface AnnotationInfo {
  /** 去掉 @ 后的注解名，如 Override / Service */
  name: string;
  /** 括号内原始文本（不含括号本身），无参数则空 */
  arguments?: string;
  startIndex: number;
  endIndex: number;
}

/** 注释种类：Javadoc 指以 /** 开头的块注释 */
export type CommentKind = 'line' | 'block' | 'javadoc';

/** 注释信息 */
export interface CommentInfo {
  kind: CommentKind;
  /** 净文本：去除行注释符、块注释定界符与行首星号之后的正文 */
  text: string;
  /** 原始文本 */
  raw: string;
  startIndex: number;
  endIndex: number;
}

/** 形参 */
export interface ParameterInfo {
  type: string;
  name: string;
}

/** 属性/常量元信息 */
export interface FieldInfo {
  name: string;
  /** 类型原始文本，如 String / List<Foo> / int */
  type: string;
  /** public/static/final 等 */
  modifiers: string[];
  annotations: AnnotationInfo[];
  comments: CommentInfo[];
  /** 简单名是否为常量（全大写下划线启发） */
  isConstant: boolean;
  startIndex: number;
  endIndex: number;
}

/** 方法/构造器元信息 */
export interface MethodInfo {
  name: string;
  /** 返回类型原始文本；构造器为空字符串 */
  returnType: string;
  parameters: ParameterInfo[];
  modifiers: string[];
  throws: string[];
  annotations: AnnotationInfo[];
  comments: CommentInfo[];
  /** 方法体范围，用于关系分析时定位 AST 子树 */
  bodyRange?: { start: number; end: number };
  startIndex: number;
  endIndex: number;
  /** 构造器标识 */
  isConstructor: boolean;
}

/** 类种类 */
export type ClassKind = 'class' | 'interface' | 'enum' | 'record';

/** 类元信息 */
export interface ClassInfo {
  kind: ClassKind;
  name: string;
  /** 简单名（内部类可能含 $ 分隔） */
  simpleName: string;
  package: string;
  filePath: string;
  /** 全限定名 package.name */
  fqn: string;
  modifiers: string[];
  annotations: AnnotationInfo[];
  comments: CommentInfo[];
  /** 父类（简单名或 FQN，已尽力解析） */
  superClass?: string;
  /** 实现的接口列表 */
  interfaces: string[];
  fields: FieldInfo[];
  methods: MethodInfo[];
  /** 内部类递归 */
  innerClasses: ClassInfo[];
  startIndex: number;
  endIndex: number;
}

/** 关系种类 */
export type RelationType =
  | 'inherit'
  | 'implement'
  | 'call'
  | 'field-access'
  | 'instantiate';

/** 关系端点：类 FQN + 可选成员名 */
export interface RelationEndpoint {
  /** 类 FQN */
  class: string;
  /** 方法名或属性名；类级关系（继承/实现）时为空 */
  member?: string;
}

/** 关系 */
export interface Relation {
  type: RelationType;
  source: RelationEndpoint;
  target: RelationEndpoint;
  /** 关系发生处所在文件与位置，便于回溯 */
  evidence?: { file: string; startIndex: number; endIndex: number };
}

/** 文件级解析中间结果 */
export interface FileParseResult {
  filePath: string;
  package: string;
  imports: string[];
  classes: ClassInfo[];
}

/** 未决符号：带文件与位置，便于回溯排错 */
export interface UnresolvedSymbol {
  /** 短名或原始文本 */
  symbol: string;
  /** 未决种类：call-object / call-name / field-object / superclass / interface / other */
  kind: string;
  /** 所在文件 */
  file?: string;
  /** 起始下标 */
  startIndex?: number;
  /** 终止下标 */
  endIndex?: number;
  /** 所属类 FQN（若可知） */
  contextClass?: string;
  /** 所属方法名（若可知） */
  contextMember?: string;
}

/** 工程级最终结果 */
export interface ParseResult {
  classes: ClassInfo[];
  relations: Relation[];
  /** 未能解析为 FQN 的符号，带位置便于排错 */
  unresolvedSymbols: UnresolvedSymbol[];
}

// ==================== 纯图对象模型 ====================

/** 图节点种类 */
export type GraphNodeType = 'class' | 'method' | 'field' | 'annotation' | 'external';

/** 图节点 */
export interface GraphNode {
  /** 唯一 ID：类=fqn，方法=`fqn#name`，字段=`fqn.fieldName` */
  id: string;
  type: GraphNodeType;
  /** 显示名 */
  label: string;
  /** 所属类 FQN（方法/字段节点必填，类节点同 id） */
  classFqn: string;
  /** 类种类（class/interface/enum/record），仅类节点填 */
  kind?: ClassKind;
  /** 字段类型 / 方法返回类型 */
  dataType?: string;
  /** 方法参数（仅方法节点） */
  parameters?: ParameterInfo[];
  /** 方法是否构造器 */
  isConstructor?: boolean;
  modifiers?: string[];
  annotations?: AnnotationInfo[];
  comments?: CommentInfo[];
  filePath?: string;
  startIndex?: number;
  endIndex?: number;
}

/** 图边种类 */
export type GraphEdgeType =
  | 'contains'          // 类含方法/字段
  | 'inherit'           // 类继承类
  | 'implement'         // 类实现接口
  | 'override'          // 子类方法重写父类方法
  | 'implement-method' // 实现类方法实现接口方法
  | 'call'             // 方法调用方法
  | 'field-access'     // 方法访问字段
  | 'instantiate'      // 方法 new 创建类
  | 'type-ref'         // 字段/参数/返回类型引用类
  | 'annotate';        // 声明被注解标注（有参注解方立节点）

/** 图边 */
export interface GraphEdge {
  type: GraphEdgeType;
  source: string; // node id
  target: string;      // node id
  evidence?: { file?: string; startIndex?: number; endIndex?: number };
}

/** 纯图对象 */
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
