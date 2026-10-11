import { Component, type ErrorInfo, type ReactNode } from "react";

/** ErrorBoundary 속성. */
export interface ErrorBoundaryProps {
  /** 감쌀 화면. */
  children: ReactNode;
  /** '다시 불러오기'를 누르면 부른다(기본: location.reload). 테스트에서 바꿔 끼운다. */
  onReload?: () => void;
}

/** ErrorBoundary 상태. */
interface ErrorBoundaryState {
  /** 자식이 그리다 오류를 냈는지. */
  hasError: boolean;
}

/** 기본 다시 불러오기: 앱 전체를 다시 읽는다. */
function reloadPage(): void {
  window.location.reload();
}

/**
 * 최상위 오류 경계(F10). 화면 코드가 그리다 던지면 React는 앱 전체를 지워 빈 화면이 된다.
 * iOS 홈 화면 앱에는 새로고침이 없어 빈 화면에서 빠져나올 길이 없으므로, 안내와 '다시 불러오기'를 보여 준다.
 * 오류 내용은 개발자 도구에만 남기고 화면에는 보이지 않는다.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  /** 처음에는 오류 없음. 자식이 던지면 getDerivedStateFromError가 바꾼다. */
  override state: ErrorBoundaryState = { hasError: false };

  /** 자식의 오류를 받으면 대체 화면으로 바꾼다. */
  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  /**
   * 개발자용 기록을 남긴다(채팅 원문은 화면 상태에 있어도 오류 객체에 담지 않는다).
   * @param error 자식이 던진 오류
   * @param info 오류가 난 컴포넌트 위치
   */
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("화면을 그리다 오류가 났습니다. '다시 불러오기'로 회복합니다.", error, info.componentStack);
  }

  /** 오류가 없으면 자식을, 있으면 안내와 '다시 불러오기'를 그린다. */
  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <main className="login" role="alert">
        <h1>문제가 생겼습니다</h1>
        <p>화면을 그리는 중 오류가 났습니다. 다시 불러와 주세요.</p>
        <button type="button" className="button primary" onClick={this.props.onReload ?? reloadPage}>다시 불러오기</button>
      </main>
    );
  }
}
