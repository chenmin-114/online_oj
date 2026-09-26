/**
 * 支持的编程语言定义
 * Judge0 CE 语言 ID: https://ce.judge0.com/languages
 */
window.LANGUAGES = [
  {
    id: 'c',
    name: 'C',
    judge0LanguageId: 103, // GCC 14.1.0
    monacoLang: 'c',
    template: `#include <stdio.h>

int main() {
    // 在此编写你的代码
    
    return 0;
}
`,
  },
  {
    id: 'cpp',
    name: 'C++',
    judge0LanguageId: 105, // GCC 14.1.0
    monacoLang: 'cpp',
    template: `#include <iostream>
using namespace std;

int main() {
    // 在此编写你的代码
    
    return 0;
}
`,
  },
  {
    id: 'python',
    name: 'Python 3',
    judge0LanguageId: 92, // Python 3.11.2
    monacoLang: 'python',
    template: `# 在此编写你的代码
`,
  },
  {
    id: 'java',
    name: 'Java',
    judge0LanguageId: 91, // JDK 17.0.6
    monacoLang: 'java',
    template: `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        // 在此编写你的代码
        
    }
}
`,
  },
  {
    id: 'javascript',
    name: 'JavaScript',
    judge0LanguageId: 93, // Node.js 18.15.0
    monacoLang: 'javascript',
    template: `const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

const lines = [];
rl.on('line', (line) => lines.push(line))
  .on('close', () => {
    // 在此编写你的代码
    // lines 数组包含所有输入行
    
  });
`,
  },
  {
    id: 'go',
    name: 'Go',
    judge0LanguageId: 106, // Go 1.22.0
    monacoLang: 'go',
    template: `package main

import "fmt"

func main() {
    // 在此编写你的代码
    fmt.Println("Hello")
}
`,
  },
  {
    id: 'rust',
    name: 'Rust',
    judge0LanguageId: 108, // Rust 1.85.0
    monacoLang: 'rust',
    template: `use std::io;

fn main() {
    // 在此编写你的代码
    
}
`,
  },
];

/**
 * 根据 id 获取语言定义
 */
function getLanguageById(id) {
  return window.LANGUAGES.find(lang => lang.id === id) || window.LANGUAGES[0];
}

function getProblemLanguageTemplate(languageId, problem) {
  const language = getLanguageById(languageId);
  if (languageId !== 'python' || problem?.pythonJudgeMode !== 'function' || !problem.pythonFunction?.signature) {
    return language.template;
  }

  return `from typing import List, Optional

class Solution:
    def ${problem.pythonFunction.signature}:
        # 在此编写你的代码
        pass
`;
}

/**
 * 为浏览器里的“运行”功能添加核心函数调用器。正式提交时 Worker 会独立
 * 生成同类调用器，不能通过修改浏览器代码伪造成绩。
 */
function buildPythonFunctionScript(source, pythonFunction) {
  if (!pythonFunction?.methodName || !Array.isArray(pythonFunction.parameterTypes)) return source;
  const config = JSON.stringify({
    methodName: pythonFunction.methodName,
    parameterTypes: pythonFunction.parameterTypes,
  });

  return `${pythonFunctionPrelude()}\n${source}\n${pythonFunctionHarness(config)}`;
}

function pythonFunctionPrelude() {
  return `from typing import List, Optional, Any
import json as __oj_json
import sys as __oj_sys

class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right
`;
}

function pythonFunctionHarness(configLiteral) {
  return `
def __oj_convert(value, type_name):
    type_name = type_name.replace(' ', '')
    if type_name.startswith('Optional[') and type_name.endswith(']'):
        if value is None:
            return None
        type_name = type_name[9:-1]
    if type_name in ('Any', ''):
        return value
    if type_name == 'int':
        return int(value)
    if type_name == 'float':
        return float(value)
    if type_name == 'str':
        return str(value)
    if type_name == 'bool':
        return bool(value)
    if (type_name.startswith('List[') or type_name.startswith('list[')) and type_name.endswith(']'):
        item_type = type_name[type_name.index('[') + 1:-1]
        return [__oj_convert(item, item_type) for item in value]
    if type_name == 'ListNode':
        values = value.get('values', []) if isinstance(value, dict) else value
        cycle_position = value.get('pos', -1) if isinstance(value, dict) else -1
        nodes = [ListNode(item) for item in values]
        for index in range(len(nodes) - 1):
            nodes[index].next = nodes[index + 1]
        if nodes and isinstance(cycle_position, int) and 0 <= cycle_position < len(nodes):
            nodes[-1].next = nodes[cycle_position]
        return nodes[0] if nodes else None
    if type_name == 'TreeNode':
        if not value or value[0] is None:
            return None
        nodes = [None if item is None else TreeNode(item) for item in value]
        child = 1
        for node in nodes:
            if node is None:
                continue
            if child < len(nodes):
                node.left = nodes[child]
                child += 1
            if child < len(nodes):
                node.right = nodes[child]
                child += 1
        return nodes[0]
    return value

def __oj_serialize(value):
    if isinstance(value, ListNode):
        result, visited = [], set()
        while value is not None and id(value) not in visited and len(result) < 10000:
            visited.add(id(value))
            result.append(value.val)
            value = value.next
        return result
    if isinstance(value, TreeNode):
        result, queue = [], [value]
        while queue and len(result) < 10000:
            node = queue.pop(0)
            if node is None:
                result.append(None)
                continue
            result.append(node.val)
            queue.extend([node.left, node.right])
        while result and result[-1] is None:
            result.pop()
        return result
    if isinstance(value, tuple):
        return [__oj_serialize(item) for item in value]
    if isinstance(value, list):
        return [__oj_serialize(item) for item in value]
    if isinstance(value, dict):
        return {key: __oj_serialize(item) for key, item in value.items()}
    return value

def __oj_print(value):
    value = __oj_serialize(value)
    if isinstance(value, bool):
        print('true' if value else 'false')
    elif value is None:
        print('null')
    elif isinstance(value, str):
        print(value)
    elif isinstance(value, (list, dict)):
        print(__oj_json.dumps(value, ensure_ascii=False, separators=(',', ':')))
    else:
        print(value)

__oj_config = ${configLiteral}
if 'Solution' in globals() and hasattr(Solution, __oj_config['methodName']):
    __oj_text = __oj_sys.stdin.read().strip()
    __oj_raw = __oj_json.loads(__oj_text) if __oj_text else None
    __oj_types = __oj_config['parameterTypes']
    if len(__oj_types) == 0:
        __oj_values = []
    elif len(__oj_types) == 1:
        __oj_values = [__oj_raw]
    else:
        if not isinstance(__oj_raw, list) or len(__oj_raw) != len(__oj_types):
            raise ValueError('多个参数的测试输入必须是长度匹配的 JSON 数组')
        __oj_values = __oj_raw
    __oj_args = [__oj_convert(value, type_name) for value, type_name in zip(__oj_values, __oj_types)]
    __oj_print(getattr(Solution(), __oj_config['methodName'])(*__oj_args))
`;
}
