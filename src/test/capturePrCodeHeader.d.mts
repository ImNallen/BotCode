export function capturePrCodeHeader(): () => void;
export function capturedViewedPress(): () => void;
export function capturedFileCollapsed(): boolean;

export function clickCheckbox(button: { props: { onClick: unknown } }): boolean;
