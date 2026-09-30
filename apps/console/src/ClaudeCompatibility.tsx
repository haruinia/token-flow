export function ClaudeCompatibility(){
 return <section className="connectionDetails" aria-label="Claude Code 兼容说明">
  <p><strong>已配置模型 ≠ 自动审批可用</strong></p>
  <p className="hint">模型和审批请求复用 CLIProxyAPI 转换，最终审批与执行由 Claude Code 控制。配置检查不能验证当前模型的 Auto Mode；App 的“替我审批”只处理网关维修。</p>
  <details><summary>遇到 Auto Mode 审批超时怎么办？</summary>
   <p className="hint">“could not evaluate”或“timed out”表示审批没有完成，不表示命令危险。新版免费审批的网关兼容通知是另一件事。</p>
   <p className="hint">需要继续工作时，可在终端使用 <code>claude --permission-mode default</code> 新开会话，改由你逐次审批。此操作不修改现有配置，也不代表自动审批已经修复。</p>
   <p className="hint">若要继续使用 Auto Mode，需验证分类器请求的耗时、响应格式和支持的模型。普通文本或工具调用成功，不能证明自动审批可用。</p>
   <a href="https://code.claude.com/docs/en/permission-modes#server-side-classifier-review" target="_blank" rel="noreferrer">查看 Claude Code 官方说明</a>
  </details>
 </section>;
}
