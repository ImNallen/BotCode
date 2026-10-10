# Isolated native verification

The actual macOS Tauri app was built from the working source and driven through native accessibility and screenshots. Repositories and BOT_CODE_DATA_DIR values were disposable. Git effects used real local bare destinations; Codex generation and GitHub CLI responses used executable fixtures. No real GitHub repository or PR was created.

## Source Control settings

Fixture /tmp/bot-source-control-settings-native. Checked controls, project scope, inheritance/reset, custom instructions, template setting, merge default, fetch interval and automatic pull in the actual app. Native layout checked at 1100x780 and 1000x620. Real Git checks and captured generator prompts passed in fetch-check.json, auto-pull-check.json, custom-preview-check.json, template-pr-check.json and settings-check.json. Settings and project overrides were persisted.

## Publish repository

Fixture /tmp/bot-publish-native-v2. Ready and signed-out provider flows, Setup Required navigation, in-modal setup tooltip, Rescan and account reveal were observed in the actual app. GH_HOST was enterprise.invalid for the app, while calls were pinned to github.com. github-readiness-check.json passed before publication.

The fixed build at 1100x780 published private SSH fixture/published. While Publishing... was visible, Escape and backdrop click retained the locked dialog. Repository published named main, with Open on GitHub and Done. publish-check.json verified exactly one create, raw remote.origin.url, unchanged local HEAD, matching bare main and configured upstream.

At the 1000x620 native minimum, the expanded wizard fit Public, HTTPS and custom remote upstream. Publishing fixture/empty preserved unrelated upstream and chose upstream-1. Repository created named that remote and instructed making a commit. publish-empty-check.json verified no local or bare refs and correct raw HTTPS URLs.

The minimum build published fixture/rejected, whose local bare pre-receive hook rejected the push. The failure alert displayed the retained repository/remote, full named-ref recovery command and hook explanation. Publish remained disabled against unsafe repeat creation. The long alert scrolled to its reachable footer. publish-rejected-check.json verified exactly one create, retained SSH origin, unchanged HEAD and no bare refs. Source Control settings retained compact neutral provider rows at the minimum size.

Independent publication fix checks are /tmp/bot-publish-fix-review.md. Build logs are /tmp/bot-publish-fixed-tauri-build.log and /tmp/bot-publish-minimum-tauri-build.log. Renderer tests passed 635. The delegate's real-Git suites passed 47 existing Git tests and 15 publication tests. The parent's build caught and corrected one TypeScript narrowing error in the newly strengthened test before native verification.

## Feature-branch continuation

Passed using /tmp/bot-feature-branch-native. Feature continuation, clean refusals and PR completion used fixed bundles built from the final working source. Abort was checked in the earlier item3 bundle before the clean-default shortcut correction; its handler was unchanged by that correction. Independent code review /tmp/bot-feature-branch-review.md passed. A comment review exposed two stale clean-default quick actions; /tmp/bot-feature-branch-quick-fix-before.log recorded four failing cases before restoring the exact T3 ternary. Main renderer tests then passed 641. Final combined native tests passed 153 unit, 53 Git and 15 publication tests in /tmp/bot-source-control-final-native-tests.log.

At 1100x780, Abort retained main, HEAD, dirty files and an empty index. feature-abort-check.json passed. Then Commit & push selected only README.md, excluded.txt stayed unchecked, and the typed message was Native branch choice. The default confirmation showed exact T3 description and three buttons. Check out feature branch & continue created feature/native-branch-choice-2, committed README.md with the approved message, pushed the new head with upstream, kept main unchanged and gh-merge-base main, retained excluded.txt unstaged and offered Create PR. feature-branch-check.json passed.

At 1000x620 the clean ahead-of-main fixture displayed Push. Its confirmation's three buttons fit. Feature choice produced Action failed / Cannot create a feature branch because there are no changes to commit. The direct menu Push choice produced Feature-branch checkout is only supported for commit actions. feature-clean-refusal-check.json and feature-direct-refusal-check.json verified unchanged main, HEAD, clean index and remote, with no new branch.

After preserving excluded.txt outside the checkout to make it clean, the feature fixture offered Create PR. The actual app ran it and displayed Created PR #41, View PR and the optional right PR panel naming feature/native-branch-choice-2 into main. feature-pr-check.json verified exactly one fixture create with the new head and original base. The excluded file was restored afterwards and feature-branch-check.json passed again. No real GitHub PR was created or linked.

Build logs /tmp/bot-feature-fixed-default-build.log and /tmp/bot-feature-fixed-minimum-build.log passed. Formatter checks and cargo fmt passed. App PIDs 98084 and 3086 used /private/tmp/bot-feature-branch-native/state exclusively; the old PID 77071 was stopped before launching the fixed bundle. Native actions used local bare destinations and executable gh/Codex fixtures. The app's minimum layout preserved the sidebar, compact header, centered chat, composer and optional tools panel.
