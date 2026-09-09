import { parseJava } from '../src/parser/java-parser';

const content = `class A {
  void foo() {
    for (String s : list) {
      s.length();
    }
  }
}`;

parseJava(content).then(tree => {
  const root = tree.rootNode;
  function walk(n: any, d: number) {
    console.log(' '.repeat(d) + n.type);
    for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i), d + 2);
  }
  walk(root, 0);
});
