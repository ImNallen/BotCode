// Ported from T3 Code v0.0.45 desktop/permissions/MacPermissionHelper.ts and MacSettingsWindow.ts (MIT).
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

bool bot_permission_granted(int permission) {
    return permission == 0 ? CGPreflightScreenCaptureAccess() : AXIsProcessTrusted();
}

typedef struct { double x, y, width, height; } BotHelperFrame;
BotHelperFrame bot_helper_frame(double x, double y, double width, double height, double primaryTop) {
    double helperWidth = MIN(560, width - 216 - 32);
    double left = round(x + 216 + (width - 216 - helperWidth) / 2);
    double top = round(y + height - 140 - 16);
    return (BotHelperFrame){left, primaryTop - top - 140, round(helperWidth), 140};
}
int bot_helper_action(bool owner, bool granted, bool tracking, bool found, bool settings, bool frontmost, bool focused) {
    if (!owner) return 3;
    if (granted) return 2;
    if (!tracking) return 0;
    if (!settings) return found ? 2 : 0;
    return frontmost || focused ? 1 : 0;
}

static NSColor *BotPermissionColor(NSView *view, unsigned light, unsigned dark) {
    BOOL darkMode = [[view.effectiveAppearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]] isEqualToString:NSAppearanceNameDarkAqua];
    unsigned rgb = darkMode ? dark : light;
    return [NSColor colorWithSRGBRed:((rgb >> 16) & 255) / 255.0 green:((rgb >> 8) & 255) / 255.0 blue:(rgb & 255) / 255.0 alpha:1];
}
@interface BotPermissionBackground : NSView
@property(nonatomic, weak) NSButton *closeButton;
@property(nonatomic, strong) NSTrackingArea *hoverArea;
@end
@implementation BotPermissionBackground
- (void)updateTrackingAreas {
    if (self.hoverArea) [self removeTrackingArea:self.hoverArea];
    self.hoverArea = [[NSTrackingArea alloc] initWithRect:self.bounds options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways | NSTrackingInVisibleRect owner:self userInfo:nil];
    [self addTrackingArea:self.hoverArea];
    [super updateTrackingAreas];
}
- (void)mouseEntered:(NSEvent *)event { self.closeButton.alphaValue = 1; }
- (void)mouseExited:(NSEvent *)event { if (self.window.firstResponder != self.closeButton) self.closeButton.alphaValue = 0; }
- (void)viewDidChangeEffectiveAppearance { [self setNeedsDisplay:YES]; for (NSView *child in self.subviews) [child setNeedsDisplay:YES]; }
- (void)drawRect:(NSRect)dirtyRect {
    NSBezierPath *panel = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds, 2.5, 2.5) xRadius:24 yRadius:24];
    [BotPermissionColor(self, 0xffffff, 0x242424) setFill]; [panel fill];
    [BotPermissionColor(self, 0xe3e3e3, 0x484848) setStroke]; [panel stroke];
}
@end
@interface BotPermissionCloseButton : NSButton
@end
@implementation BotPermissionCloseButton
- (BOOL)becomeFirstResponder { self.alphaValue = 1; return [super becomeFirstResponder]; }
@end

@interface BotPermissionPanel : NSPanel
@end
@implementation BotPermissionPanel
- (BOOL)canBecomeKeyWindow { return YES; }
@end

@interface BotPermissionRow : NSView <NSDraggingSource>
@property(nonatomic, strong) NSURL *bundle;
@property(nonatomic, strong) NSImage *icon;
@end
@implementation BotPermissionRow
- (void)mouseDown:(NSEvent *)event {}
- (void)mouseUp:(NSEvent *)event { [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:@[self.bundle]]; }
- (void)mouseDragged:(NSEvent *)event {
    NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:self.bundle];
    [item setDraggingFrame:NSMakeRect(12, 10, 32, 32) contents:self.icon];
    [self beginDraggingSessionWithItems:@[item] event:event source:self];
}
- (NSDragOperation)draggingSession:(NSDraggingSession *)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
    return context == NSDraggingContextOutsideApplication ? NSDragOperationCopy : NSDragOperationNone;
}
- (void)drawRect:(NSRect)dirtyRect {
    [BotPermissionColor(self, 0xe7e7e7, 0x383838) setFill];
    [[NSBezierPath bezierPathWithRoundedRect:self.bounds xRadius:10 yRadius:10] fill];
    [self.icon drawInRect:NSMakeRect(12, 10, 32, 32)];
    [@"Bot Code" drawAtPoint:NSMakePoint(56, 16) withAttributes:@{NSFontAttributeName: [NSFont systemFontOfSize:16 weight:NSFontWeightSemibold], NSForegroundColorAttributeName: BotPermissionColor(self, 0x292929, 0xf5f5f5)}];
}
@end

@interface BotPermissionHelper : NSObject <NSWindowDelegate>
@property(nonatomic, strong) NSPanel *panel;
@property(nonatomic, weak) NSWindow *owner;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic) int permission;
@property(nonatomic) BOOL foundSettings;
- (void)finish;
- (void)tick;
@end
static BotPermissionHelper *activeHelper;
@implementation BotPermissionHelper
- (void)finish {
    [self.timer invalidate];
    self.timer = nil;
    self.panel.delegate = nil;
    [self.panel close];
    self.panel = nil;
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    if (activeHelper == self) activeHelper = nil;
}
- (void)closeAndReturn:(id)sender {
    NSWindow *owner = self.owner;
    [self finish];
    [owner makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}
- (void)ownerClosed:(NSNotification *)notification { [self finish]; }
- (void)windowWillClose:(NSNotification *)notification { [self finish]; }
- (void)windowDidResignKey:(NSNotification *)notification { [self tick]; }
- (void)tick {
    if (!self.owner) { [self finish]; return; }
    if (bot_permission_granted(self.permission)) { [self closeAndReturn:nil]; return; }
    NSRunningApplication *settings = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.systempreferences"].firstObject;
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSDictionary *match = nil;
    for (NSDictionary *window in windows) {
        NSDictionary *bounds = window[(id)kCGWindowBounds];
        if (settings && [window[(id)kCGWindowOwnerPID] intValue] == settings.processIdentifier && [window[(id)kCGWindowLayer] intValue] == 0 && [bounds[@"Width"] doubleValue] >= 500 && [bounds[@"Height"] doubleValue] >= 350) { match = bounds; break; }
    }
    BOOL frontmost = settings && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == settings.processIdentifier;
    int action = bot_helper_action(self.owner != nil, bot_permission_granted(self.permission), windows != nil, self.foundSettings, match != nil, frontmost, self.panel.isKeyWindow);
    if (match) self.foundSettings = YES;
    if (action == 3) { [self finish]; return; }
    if (action == 2) { [self closeAndReturn:nil]; return; }
    if (action == 0) { [self.panel orderOut:nil]; return; }
    BotHelperFrame frame = bot_helper_frame([match[@"X"] doubleValue], [match[@"Y"] doubleValue], [match[@"Width"] doubleValue], [match[@"Height"] doubleValue], NSScreen.screens.firstObject.frame.size.height);
    [self.panel setFrame:NSMakeRect(frame.x, frame.y, frame.width, frame.height) display:YES];
    [self.panel orderFrontRegardless];
}
@end

int bot_permission_open(int permission, void *ownerPointer) {
    NSCAssert(NSThread.isMainThread, @"Permission UI requires the main thread");
    [activeHelper finish];
    NSString *url = permission == 0 ? @"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" : @"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
    if (![NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:url]]) return -1;
    NSString *executable = NSBundle.mainBundle.executablePath;
    NSString *bundle = [[executable stringByDeletingLastPathComponent] stringByDeletingLastPathComponent].stringByDeletingLastPathComponent;
    if (![bundle.pathExtension isEqualToString:@"app"] || ![[executable stringByDeletingLastPathComponent].lastPathComponent isEqualToString:@"MacOS"] || ![[[executable stringByDeletingLastPathComponent] stringByDeletingLastPathComponent].lastPathComponent isEqualToString:@"Contents"]) return 0;
    if (bot_permission_granted(permission)) return 1;
    NSWindow *owner = (__bridge NSWindow *)ownerPointer;
    if (!owner) return -1;
    BotPermissionHelper *helper = [BotPermissionHelper new];
    helper.permission = permission;
    helper.owner = owner;
    NSPanel *panel = [[BotPermissionPanel alloc] initWithContentRect:NSMakeRect(0, 0, 560, 140) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    panel.releasedWhenClosed = NO;
    panel.level = NSFloatingWindowLevel;
    panel.hidesOnDeactivate = NO;
    panel.hasShadow = NO;
    panel.opaque = NO;
    panel.backgroundColor = NSColor.clearColor;
    panel.title = permission == 0 ? @"Set up Screen Recording" : @"Set up Accessibility";
    panel.delegate = helper;
    BotPermissionBackground *content = [[BotPermissionBackground alloc] initWithFrame:NSMakeRect(0, 0, 560, 140)];
    panel.contentView = content;
    NSTextField *label = [NSTextField labelWithString:@"↑ Drag Bot Code into the list above"];
    label.font = [NSFont systemFontOfSize:15 weight:NSFontWeightSemibold];
    label.frame = NSMakeRect(22, 96, 500, 22);
    label.autoresizingMask = NSViewWidthSizable;
    [content addSubview:label];
    BotPermissionRow *row = [[BotPermissionRow alloc] initWithFrame:NSMakeRect(22, 22, 516, 52)];
    row.bundle = [NSURL fileURLWithPath:bundle isDirectory:YES];
    row.icon = [NSWorkspace.sharedWorkspace iconForFile:bundle];
    row.autoresizingMask = NSViewWidthSizable;
    [row setAccessibilityLabel:@"Drag Bot Code to System Settings"];
    [content addSubview:row];
    NSButton *close = [BotPermissionCloseButton buttonWithTitle:@"×" target:helper action:@selector(closeAndReturn:)];
    close.frame = NSMakeRect(530, 112, 22, 22);
    close.bordered = NO;
    close.alphaValue = 0;
    content.closeButton = close;
    close.autoresizingMask = NSViewMinXMargin;
    [close setAccessibilityLabel:@"Close permission helper"];
    [content addSubview:close];
    helper.panel = panel;
    activeHelper = helper;
    [[NSNotificationCenter defaultCenter] addObserver:helper selector:@selector(ownerClosed:) name:NSWindowWillCloseNotification object:owner];
    __weak BotPermissionHelper *weakHelper = helper;
    helper.timer = [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *timer __attribute__((unused))) { [weakHelper tick]; }];
    [helper tick];
    return 1;
}
