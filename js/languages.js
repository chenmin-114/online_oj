/**
 * 支持的编程语言定义
 * language/version 必须与 Piston API 的 runtimes 匹配
 * 查看可用语言: GET https://emkc.org/api/v2/piston/runtimes
 */
window.LANGUAGES = [
  {
    id: 'c',
    name: 'C',
    version: '10.2.0',
    pistonLang: 'c',
    pistonVersion: '10.2.0',
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
    version: '10.2.0',
    pistonLang: 'c++',
    pistonVersion: '10.2.0',
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
    version: '3.10.0',
    pistonLang: 'python',
    pistonVersion: '3.10.0',
    monacoLang: 'python',
    template: `# 在此编写你的代码
`,
  },
  {
    id: 'java',
    name: 'Java',
    version: '15.0.2',
    pistonLang: 'java',
    pistonVersion: '15.0.2',
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
    version: '18.15.0',
    pistonLang: 'javascript',
    pistonVersion: '18.15.0',
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
    version: '1.16.2',
    pistonLang: 'go',
    pistonVersion: '1.16.2',
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
    version: '1.68.2',
    pistonLang: 'rust',
    pistonVersion: '1.68.2',
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
