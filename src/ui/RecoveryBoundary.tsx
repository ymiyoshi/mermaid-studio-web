import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { exportBackup } from '../io/backup';
import { exportCurrentDoc, restartWithoutLastDoc } from '../io/recovery';
import { t } from '../i18n';

// 画面全体の ErrorBoundary。描画中の例外で白い画面のまま止まらないよう、復旧画面に切り替える。
// 壊れた図が IndexedDB に残っていると、読み込み直すたびに同じ例外になりうるので、
// 図を外に持ち出す口と、その図を開かずに起動する口を出す。図を消す操作は置かない。

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/** 描画の外で起きた、続けられない失敗（起動処理の失敗など）。表示中の RecoveryBoundary に渡す */
let fatalError: Error | null = null;
const fatalListeners = new Set<(e: Error) => void>();

/**
 * 起動処理（init）のように、失敗すると画面が「読み込み中」のまま進まなくなる処理の例外を受けて、復旧画面に切り替える。
 * 描画中の例外ではないので、React の ErrorBoundary だけでは拾えない
 */
export function showRecovery(error: unknown) {
  console.error(error);
  fatalError = toError(error);
  for (const listener of fatalListeners) listener(fatalError);
}

export class RecoveryBoundary extends Component<Props, State> {
  state: State = { error: fatalError };
  private readonly onFatal = (error: Error) => this.setState({ error });

  static getDerivedStateFromError(error: unknown): State {
    return { error: toError(error) };
  }

  componentDidMount() {
    fatalListeners.add(this.onFatal);
    // 組み立ててから購読するまでの間に起きた失敗も拾う
    if (fatalError && this.state.error !== fatalError) this.setState({ error: fatalError });
  }

  componentWillUnmount() {
    fatalListeners.delete(this.onFatal);
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (this.state.error) return <RecoveryScreen error={this.state.error} />;
    return this.props.children;
  }
}

export function RecoveryScreen({ error }: { error: Error }) {
  // 復旧画面ではトーストが出ない（App ごと外れている）ので、結果はこの画面に出す
  const [message, setMessage] = useState<string | null>(null);
  const run = (action: () => Promise<string | null>) => async () => {
    try {
      setMessage(await action());
    } catch (e) {
      setMessage(t('recovery.failed', { message: String((e as Error)?.message ?? e) }));
    }
  };

  const saveCurrent = run(async () => {
    const name = await exportCurrentDoc();
    return name ? t('recovery.exported', { name }) : t('recovery.noCurrent');
  });
  const backupAll = run(async () => {
    await exportBackup();
    return null;
  });

  return (
    <div className="recovery" role="alert">
      <div className="modal recovery-panel">
        <h2>{t('recovery.title')}</h2>
        <p className="modal-note">{t('recovery.body')}</p>
        <details className="recovery-details">
          <summary>{t('recovery.details')}</summary>
          <pre>{`${error.name}: ${error.message}${error.stack ? `\n\n${error.stack}` : ''}`}</pre>
        </details>
        <div className="recovery-actions">
          <button className="btn primary" onClick={() => location.reload()}>
            {t('recovery.reload')}
          </button>
          <button className="btn" onClick={() => void saveCurrent()}>
            {t('recovery.exportCurrent')}
          </button>
          <button className="btn" onClick={() => void backupAll()}>
            {t('recovery.exportAll')}
          </button>
          <button className="btn" onClick={() => restartWithoutLastDoc()}>
            {t('recovery.safeStart')}
          </button>
        </div>
        {message && (
          <p className="recovery-message" role="status">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
