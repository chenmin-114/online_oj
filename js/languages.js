/**
 * 支持的编程语言定义
 * JDoodle API: https://api.jdoodle.com/v1/execute
 * 语言标识参考: https://www.jdoodle.com/compiler-api/docs
 */
window.LANGUAGES = [
  {
    id: 'c',
    name: 'C',
    jdoodleLang: 'c',
    versionIndex: '5',  // GCC 11.2.0
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
    jdoodleLang: 'cpp17',
    versionIndex: '0',  // GCC 11.2.0
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
    jdoodleLang: 'python3',
    versionIndex: '4',  // 3.11.2
    monacoLang: 'python',
    template: `# 在此编写你的代码
`,
  },
  {
    id: 'java',
    name: 'Java',
    jdoodleLang: 'java',
    versionIndex: '4',  // JDK 17.0.6
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
    jdoodleLang: 'nodejs',
    versionIndex: '4',  // 18.15.0
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
    jdoodleLang: 'go',
    versionIndex: '4',  // 1.20.1
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
    jdoodleLang: 'rust',
    versionIndex: '1',  // 1.66.1
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
