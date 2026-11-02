import { Component } from 'react';
import type { ReactNode } from 'react';

export class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert" className="scene-fallback">3D 载入或渲染不可用。API 汇总仍可查看；请检查 WebGL 和网络后重新载入场景。</p> : this.props.children; }
}
