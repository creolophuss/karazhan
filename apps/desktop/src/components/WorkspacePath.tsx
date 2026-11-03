interface WorkspacePathProps {
  path: string | null;
}

export default function WorkspacePath({ path }: WorkspacePathProps) {
  const label = path ?? "未绑定工作目录";
  return <span className="workspace-path" title={label}>{label}</span>;
}
