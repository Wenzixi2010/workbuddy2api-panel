/** 视图公共契约：每个视图都能弹 toast。 */
export type ViewProps = {
  onToast: (msg: string, kind?: 'ok' | 'err' | '') => void
}
