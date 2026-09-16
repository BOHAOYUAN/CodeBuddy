import * as parser from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import * as fs from 'fs';

export interface CodeSkeleton {
  imports: string[];
  exports: string[];
  functions: {
    name: string;
    params: string[];
    startLine?: number;
    endLine?: number;
  }[];
  classes: {
    name: string;
    methods: string[];
    startLine?: number;
    endLine?: number;
  }[];
}

export function analyzeCodeAST(filePath: string): CodeSkeleton {
  if (!fs.existsSync(filePath)) {
    throw new Error('File not found: ' + filePath);
  }

  const code = fs.readFileSync(filePath, 'utf-8');
  const ast = parser.parse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  });

  const skeleton: CodeSkeleton = {
    imports: [],
    exports: [],
    functions: [],
    classes: [],
  };

  traverse(ast, {
    ImportDeclaration(path: NodePath<any>) {
      skeleton.imports.push(path.node.source.value);
    },
    ExportNamedDeclaration(path: NodePath<any>) {
      if (path.node.declaration && (path.node.declaration as any).id) {
        skeleton.exports.push((path.node.declaration as any).id.name);
      }
    },
    ExportDefaultDeclaration() {
      skeleton.exports.push('default');
    },
    FunctionDeclaration(path: NodePath<any>) {
      const name = path.node.id ? path.node.id.name : 'anonymous';
      const params = path.node.params.map((p: any) => p.name || 'param');
      skeleton.functions.push({
        name,
        params,
        startLine: path.node.loc?.start.line,
        endLine: path.node.loc?.end.line,
      });
    },
    ClassDeclaration(path: NodePath<any>) {
      const className = path.node.id ? path.node.id.name : 'AnonymousClass';
      const methods: string[] = [];
      path.node.body.body.forEach((member: any) => {
        if (member.type === 'ClassMethod' && member.key) {
          methods.push(member.key.name);
        }
      });
      skeleton.classes.push({
        name: className,
        methods,
        startLine: path.node.loc?.start.line,
        endLine: path.node.loc?.end.line,
      });
    },
  });

  return skeleton;
}
