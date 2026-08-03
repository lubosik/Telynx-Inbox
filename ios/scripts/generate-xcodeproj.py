#!/usr/bin/env python3
"""
Generates ViciInbox.xcodeproj without needing Xcode or XcodeGen.

Why this exists: the primary path is `xcodegen generate` from project.yml, but
XcodeGen cannot be installed or built on macOS 13 (it requires Xcode 15.3+, and
SwiftPM under Command Line Tools alone cannot resolve a platform path). CI needs
a committed .xcodeproj and shared scheme to build, so we emit one here.

project.yml remains the human-readable source of truth. Keep the two in sync:
this script reads the same settings, declared once below.

Usage:  python3 scripts/generate-xcodeproj.py
"""

import hashlib
import os
import shutil

# ── Settings (mirror project.yml) ────────────────────────────────────────────
PROJECT_NAME    = "ViciInbox"
TARGET_NAME     = "ViciInbox"
PRODUCT_NAME    = "Vici Inbox"
BUNDLE_ID       = "com.vicipeptides.inbox"
DEVELOPMENT_TEAM = "PQFYN2CD77"
DEPLOYMENT_TARGET = "16.0"
SWIFT_VERSION   = "5.9"
MARKETING_VERSION = "1.0.0"
BUILD_NUMBER    = "1"

SOURCE_ROOT     = "ViciInbox"
INFO_PLIST      = "ViciInbox/Resources/Info.plist"
ENTITLEMENTS    = "ViciInbox/Resources/ViciInbox.entitlements"
ASSETS          = "ViciInbox/Resources/Assets.xcassets"

SPM_URL         = "https://github.com/team-telnyx/telnyx-webrtc-ios"
SPM_PRODUCT     = "TelnyxRTC"
SPM_EXACT_VERSION = "4.1.2"

HERE = os.path.dirname(os.path.abspath(__file__))
IOS_DIR = os.path.abspath(os.path.join(HERE, ".."))


def uid(*parts: str) -> str:
    """Deterministic 24-char uppercase hex ID, so regenerating produces an
    identical file rather than a noisy diff."""
    h = hashlib.sha1("::".join(parts).encode()).hexdigest().upper()
    return h[:24]


def find_swift_files() -> list:
    out = []
    for dirpath, dirnames, filenames in os.walk(os.path.join(IOS_DIR, SOURCE_ROOT)):
        dirnames.sort()
        for fn in sorted(filenames):
            if fn.endswith(".swift"):
                full = os.path.join(dirpath, fn)
                out.append(os.path.relpath(full, IOS_DIR))
    return out


def build_tree(paths: list) -> dict:
    """Nest relative paths into {dirname: {...}, '__files__': [paths]}."""
    tree = {}
    for p in paths:
        parts = p.split(os.sep)
        node = tree
        for d in parts[1:-1]:          # skip the SOURCE_ROOT segment
            node = node.setdefault(d, {})
        node.setdefault("__files__", []).append(p)
    return tree


def main():
    swift_files = find_swift_files()
    if not swift_files:
        raise SystemExit("No Swift files found — run from the ios/ directory.")

    # ── IDs ──────────────────────────────────────────────────────────────────
    ids = {
        "project":        uid("project"),
        "target":         uid("target"),
        "product":        uid("product"),
        "mainGroup":      uid("group", "main"),
        "productsGroup":  uid("group", "products"),
        "sourceGroup":    uid("group", SOURCE_ROOT),
        "resourcesGroup": uid("group", "Resources"),
        "sourcesPhase":   uid("phase", "sources"),
        "resourcesPhase": uid("phase", "resources"),
        "frameworksPhase": uid("phase", "frameworks"),
        "projConfigList": uid("configlist", "project"),
        "targConfigList": uid("configlist", "target"),
        "projDebug":      uid("config", "project", "debug"),
        "projRelease":    uid("config", "project", "release"),
        "targDebug":      uid("config", "target", "debug"),
        "targRelease":    uid("config", "target", "release"),
        "pkgRef":         uid("pkg", SPM_URL),
        "pkgProduct":     uid("pkgproduct", SPM_PRODUCT),
        "pkgBuildFile":   uid("pkgbuildfile", SPM_PRODUCT),
        "assetsRef":      uid("fileref", ASSETS),
        "assetsBuild":    uid("buildfile", ASSETS),
        "infoRef":        uid("fileref", INFO_PLIST),
        "entRef":         uid("fileref", ENTITLEMENTS),
    }

    L = []            # output lines
    def w(s=""):
        L.append(s)

    w("// !$*UTF8*$!")
    w("{")
    w("\tarchiveVersion = 1;")
    w("\tclasses = {")
    w("\t};")
    w("\tobjectVersion = 56;")
    w("\tobjects = {")

    # ── PBXBuildFile ─────────────────────────────────────────────────────────
    w()
    w("/* Begin PBXBuildFile section */")
    for p in swift_files:
        w(f"\t\t{uid('buildfile', p)} /* {os.path.basename(p)} in Sources */ = "
          f"{{isa = PBXBuildFile; fileRef = {uid('fileref', p)} /* {os.path.basename(p)} */; }};")
    w(f"\t\t{ids['assetsBuild']} /* Assets.xcassets in Resources */ = "
      f"{{isa = PBXBuildFile; fileRef = {ids['assetsRef']} /* Assets.xcassets */; }};")
    w(f"\t\t{ids['pkgBuildFile']} /* {SPM_PRODUCT} in Frameworks */ = "
      f"{{isa = PBXBuildFile; productRef = {ids['pkgProduct']} /* {SPM_PRODUCT} */; }};")
    w("/* End PBXBuildFile section */")

    # ── PBXFileReference ─────────────────────────────────────────────────────
    w()
    w("/* Begin PBXFileReference section */")
    w(f'\t\t{ids["product"]} /* {PRODUCT_NAME}.app */ = {{isa = PBXFileReference; '
      f'explicitFileType = wrapper.application; includeInIndex = 0; '
      f'path = "{PRODUCT_NAME}.app"; sourceTree = BUILT_PRODUCTS_DIR; }};')
    for p in swift_files:
        w(f'\t\t{uid("fileref", p)} /* {os.path.basename(p)} */ = {{isa = PBXFileReference; '
          f'lastKnownFileType = sourcecode.swift; path = {os.path.basename(p)}; '
          f'sourceTree = "<group>"; }};')
    w(f'\t\t{ids["assetsRef"]} /* Assets.xcassets */ = {{isa = PBXFileReference; '
      f'lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; }};')
    w(f'\t\t{ids["infoRef"]} /* Info.plist */ = {{isa = PBXFileReference; '
      f'lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; }};')
    w(f'\t\t{ids["entRef"]} /* {PROJECT_NAME}.entitlements */ = {{isa = PBXFileReference; '
      f'lastKnownFileType = text.plist.entitlements; path = {PROJECT_NAME}.entitlements; '
      f'sourceTree = "<group>"; }};')
    w("/* End PBXFileReference section */")

    # ── PBXFrameworksBuildPhase ──────────────────────────────────────────────
    w()
    w("/* Begin PBXFrameworksBuildPhase section */")
    w(f"\t\t{ids['frameworksPhase']} /* Frameworks */ = {{")
    w("\t\t\tisa = PBXFrameworksBuildPhase;")
    w("\t\t\tbuildActionMask = 2147483647;")
    w("\t\t\tfiles = (")
    w(f"\t\t\t\t{ids['pkgBuildFile']} /* {SPM_PRODUCT} in Frameworks */,")
    w("\t\t\t);")
    w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    w("\t\t};")
    w("/* End PBXFrameworksBuildPhase section */")

    # ── PBXGroup ─────────────────────────────────────────────────────────────
    w()
    w("/* Begin PBXGroup section */")

    tree = build_tree(swift_files)
    group_lines = []

    def emit_group(node, name, path, key):
        gid = uid("group", key)
        children = []
        for sub in sorted(k for k in node if k != "__files__"):
            sub_key = f"{key}/{sub}"
            child_id = emit_group(node[sub], sub, sub, sub_key)
            children.append(f"\t\t\t\t{child_id} /* {sub} */,")
        for f in node.get("__files__", []):
            children.append(f"\t\t\t\t{uid('fileref', f)} /* {os.path.basename(f)} */,")
        if key == SOURCE_ROOT:
            children.append(f"\t\t\t\t{uid('group', 'Resources')} /* Resources */,")

        group_lines.append(f"\t\t{gid} /* {name} */ = {{")
        group_lines.append("\t\t\tisa = PBXGroup;")
        group_lines.append("\t\t\tchildren = (")
        group_lines.extend(children)
        group_lines.append("\t\t\t);")
        group_lines.append(f"\t\t\tpath = {path};")
        group_lines.append('\t\t\tsourceTree = "<group>";')
        group_lines.append("\t\t};")
        return gid

    # main group
    w(f"\t\t{ids['mainGroup']} = {{")
    w("\t\t\tisa = PBXGroup;")
    w("\t\t\tchildren = (")
    w(f"\t\t\t\t{ids['sourceGroup']} /* {SOURCE_ROOT} */,")
    w(f"\t\t\t\t{ids['productsGroup']} /* Products */,")
    w("\t\t\t);")
    w('\t\t\tsourceTree = "<group>";')
    w("\t\t};")

    # products group
    w(f"\t\t{ids['productsGroup']} /* Products */ = {{")
    w("\t\t\tisa = PBXGroup;")
    w("\t\t\tchildren = (")
    w(f"\t\t\t\t{ids['product']} /* {PRODUCT_NAME}.app */,")
    w("\t\t\t);")
    w("\t\t\tname = Products;")
    w('\t\t\tsourceTree = "<group>";')
    w("\t\t};")

    # resources group
    w(f"\t\t{uid('group', 'Resources')} /* Resources */ = {{")
    w("\t\t\tisa = PBXGroup;")
    w("\t\t\tchildren = (")
    w(f"\t\t\t\t{ids['assetsRef']} /* Assets.xcassets */,")
    w(f"\t\t\t\t{ids['infoRef']} /* Info.plist */,")
    w(f"\t\t\t\t{ids['entRef']} /* {PROJECT_NAME}.entitlements */,")
    w("\t\t\t);")
    w("\t\t\tpath = Resources;")
    w('\t\t\tsourceTree = "<group>";')
    w("\t\t};")

    emit_group(tree, SOURCE_ROOT, SOURCE_ROOT, SOURCE_ROOT)
    for line in group_lines:
        w(line)

    w("/* End PBXGroup section */")

    # ── PBXNativeTarget ──────────────────────────────────────────────────────
    w()
    w("/* Begin PBXNativeTarget section */")
    w(f"\t\t{ids['target']} /* {TARGET_NAME} */ = {{")
    w("\t\t\tisa = PBXNativeTarget;")
    w(f"\t\t\tbuildConfigurationList = {ids['targConfigList']} /* Build configuration list */;")
    w("\t\t\tbuildPhases = (")
    w(f"\t\t\t\t{ids['sourcesPhase']} /* Sources */,")
    w(f"\t\t\t\t{ids['frameworksPhase']} /* Frameworks */,")
    w(f"\t\t\t\t{ids['resourcesPhase']} /* Resources */,")
    w("\t\t\t);")
    w("\t\t\tbuildRules = (")
    w("\t\t\t);")
    w("\t\t\tdependencies = (")
    w("\t\t\t);")
    w(f"\t\t\tname = {TARGET_NAME};")
    w("\t\t\tpackageProductDependencies = (")
    w(f"\t\t\t\t{ids['pkgProduct']} /* {SPM_PRODUCT} */,")
    w("\t\t\t);")
    w(f'\t\t\tproductName = "{PRODUCT_NAME}";')
    w(f"\t\t\tproductReference = {ids['product']} /* {PRODUCT_NAME}.app */;")
    w('\t\t\tproductType = "com.apple.product-type.application";')
    w("\t\t};")
    w("/* End PBXNativeTarget section */")

    # ── PBXProject ───────────────────────────────────────────────────────────
    w()
    w("/* Begin PBXProject section */")
    w(f"\t\t{ids['project']} /* Project object */ = {{")
    w("\t\t\tisa = PBXProject;")
    w("\t\t\tattributes = {")
    w("\t\t\t\tBuildIndependentTargetsInParallel = 1;")
    w("\t\t\t\tLastSwiftUpdateCheck = 1600;")
    w("\t\t\t\tLastUpgradeCheck = 1600;")
    w("\t\t\t\tTargetAttributes = {")
    w(f"\t\t\t\t\t{ids['target']} = {{")
    w("\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;")
    w("\t\t\t\t\t};")
    w("\t\t\t\t};")
    w("\t\t\t};")
    w(f"\t\t\tbuildConfigurationList = {ids['projConfigList']} /* Build configuration list */;")
    w('\t\t\tcompatibilityVersion = "Xcode 14.0";')
    w("\t\t\tdevelopmentRegion = en;")
    w("\t\t\thasScannedForEncodings = 0;")
    w("\t\t\tknownRegions = (")
    w("\t\t\t\ten,")
    w("\t\t\t\tBase,")
    w("\t\t\t);")
    w(f"\t\t\tmainGroup = {ids['mainGroup']};")
    w("\t\t\tpackageReferences = (")
    w(f"\t\t\t\t{ids['pkgRef']} /* XCRemoteSwiftPackageReference */,")
    w("\t\t\t);")
    w(f"\t\t\tproductRefGroup = {ids['productsGroup']} /* Products */;")
    w('\t\t\tprojectDirPath = "";')
    w('\t\t\tprojectRoot = "";')
    w("\t\t\ttargets = (")
    w(f"\t\t\t\t{ids['target']} /* {TARGET_NAME} */,")
    w("\t\t\t);")
    w("\t\t};")
    w("/* End PBXProject section */")

    # ── PBXResourcesBuildPhase ───────────────────────────────────────────────
    w()
    w("/* Begin PBXResourcesBuildPhase section */")
    w(f"\t\t{ids['resourcesPhase']} /* Resources */ = {{")
    w("\t\t\tisa = PBXResourcesBuildPhase;")
    w("\t\t\tbuildActionMask = 2147483647;")
    w("\t\t\tfiles = (")
    w(f"\t\t\t\t{ids['assetsBuild']} /* Assets.xcassets in Resources */,")
    w("\t\t\t);")
    w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    w("\t\t};")
    w("/* End PBXResourcesBuildPhase section */")

    # ── PBXSourcesBuildPhase ─────────────────────────────────────────────────
    w()
    w("/* Begin PBXSourcesBuildPhase section */")
    w(f"\t\t{ids['sourcesPhase']} /* Sources */ = {{")
    w("\t\t\tisa = PBXSourcesBuildPhase;")
    w("\t\t\tbuildActionMask = 2147483647;")
    w("\t\t\tfiles = (")
    for p in swift_files:
        w(f"\t\t\t\t{uid('buildfile', p)} /* {os.path.basename(p)} in Sources */,")
    w("\t\t\t);")
    w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    w("\t\t};")
    w("/* End PBXSourcesBuildPhase section */")

    # ── XCBuildConfiguration ─────────────────────────────────────────────────
    project_common = [
        'ALWAYS_SEARCH_USER_PATHS = NO;',
        'CLANG_ANALYZER_NONNULL = YES;',
        'CLANG_ENABLE_MODULES = YES;',
        'CLANG_ENABLE_OBJC_ARC = YES;',
        'CLANG_WARN_DOCUMENTATION_COMMENTS = YES;',
        'COPY_PHASE_STRIP = NO;',
        'ENABLE_STRICT_OBJC_MSGSEND = YES;',
        'GCC_C_LANGUAGE_STANDARD = gnu17;',
        'GCC_NO_COMMON_BLOCKS = YES;',
        f'IPHONEOS_DEPLOYMENT_TARGET = {DEPLOYMENT_TARGET};',
        'MTL_FAST_MATH = YES;',
        'SDKROOT = iphoneos;',
        f'SWIFT_VERSION = {SWIFT_VERSION};',
    ]
    target_common = [
        'ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;',
        'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor;',
        f'CODE_SIGN_ENTITLEMENTS = {ENTITLEMENTS};',
        'CODE_SIGN_STYLE = Automatic;',
        f'CURRENT_PROJECT_VERSION = {BUILD_NUMBER};',
        f'DEVELOPMENT_TEAM = {DEVELOPMENT_TEAM};',
        'ENABLE_PREVIEWS = YES;',
        'GENERATE_INFOPLIST_FILE = NO;',
        f'INFOPLIST_FILE = {INFO_PLIST};',
        'LD_RUNPATH_SEARCH_PATHS = (',
        '\t\t\t\t\t"$(inherited)",',
        '\t\t\t\t\t"@executable_path/Frameworks",',
        ');',
        f'MARKETING_VERSION = {MARKETING_VERSION};',
        f'PRODUCT_BUNDLE_IDENTIFIER = {BUNDLE_ID};',
        f'PRODUCT_NAME = "{PRODUCT_NAME}";',
        'SWIFT_EMIT_LOC_STRINGS = YES;',
        'TARGETED_DEVICE_FAMILY = 1;',
    ]

    def emit_config(cid, name, settings, extra):
        w(f"\t\t{cid} /* {name} */ = {{")
        w("\t\t\tisa = XCBuildConfiguration;")
        w("\t\t\tbuildSettings = {")
        for s in settings + extra:
            w(f"\t\t\t\t{s}")
        w("\t\t\t};")
        w(f"\t\t\tname = {name};")
        w("\t\t};")

    w()
    w("/* Begin XCBuildConfiguration section */")
    emit_config(ids["projDebug"], "Debug", project_common, [
        'DEBUG_INFORMATION_FORMAT = dwarf;',
        'ENABLE_TESTABILITY = YES;',
        'GCC_OPTIMIZATION_LEVEL = 0;',
        'GCC_PREPROCESSOR_DEFINITIONS = (',
        '\t\t\t\t\t"DEBUG=1",',
        '\t\t\t\t\t"$(inherited)",',
        ');',
        'MTL_ENABLE_DEBUG_INFO = INCLUDE_SOURCE;',
        'ONLY_ACTIVE_ARCH = YES;',
        'SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG $(inherited)";',
        'SWIFT_OPTIMIZATION_LEVEL = "-Onone";',
    ])
    emit_config(ids["projRelease"], "Release", project_common, [
        'DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";',
        'ENABLE_NS_ASSERTIONS = NO;',
        'MTL_ENABLE_DEBUG_INFO = NO;',
        'SWIFT_COMPILATION_MODE = wholemodule;',
        'VALIDATE_PRODUCT = YES;',
    ])
    emit_config(ids["targDebug"], "Debug", target_common, [])
    emit_config(ids["targRelease"], "Release", target_common, [])
    w("/* End XCBuildConfiguration section */")

    # ── XCConfigurationList ──────────────────────────────────────────────────
    w()
    w("/* Begin XCConfigurationList section */")
    for cid, dbg, rel, label in (
        (ids["projConfigList"], ids["projDebug"], ids["projRelease"], f"PBXProject \"{PROJECT_NAME}\""),
        (ids["targConfigList"], ids["targDebug"], ids["targRelease"], f"PBXNativeTarget \"{TARGET_NAME}\""),
    ):
        w(f"\t\t{cid} /* Build configuration list for {label} */ = {{")
        w("\t\t\tisa = XCConfigurationList;")
        w("\t\t\tbuildConfigurations = (")
        w(f"\t\t\t\t{dbg} /* Debug */,")
        w(f"\t\t\t\t{rel} /* Release */,")
        w("\t\t\t);")
        w("\t\t\tdefaultConfigurationIsVisible = 0;")
        w("\t\t\tdefaultConfigurationName = Release;")
        w("\t\t};")
    w("/* End XCConfigurationList section */")

    # ── Swift Package ────────────────────────────────────────────────────────
    w()
    w("/* Begin XCRemoteSwiftPackageReference section */")
    w(f'\t\t{ids["pkgRef"]} /* XCRemoteSwiftPackageReference "telnyx-webrtc-ios" */ = {{')
    w("\t\t\tisa = XCRemoteSwiftPackageReference;")
    w(f'\t\t\trepositoryURL = "{SPM_URL}";')
    w("\t\t\trequirement = {")
    w("\t\t\t\tkind = exactVersion;")
    w(f'\t\t\t\tversion = {SPM_EXACT_VERSION};')
    w("\t\t\t};")
    w("\t\t};")
    w("/* End XCRemoteSwiftPackageReference section */")

    w()
    w("/* Begin XCSwiftPackageProductDependency section */")
    w(f'\t\t{ids["pkgProduct"]} /* {SPM_PRODUCT} */ = {{')
    w("\t\t\tisa = XCSwiftPackageProductDependency;")
    w(f"\t\t\tpackage = {ids['pkgRef']} /* XCRemoteSwiftPackageReference */;")
    w(f"\t\t\tproductName = {SPM_PRODUCT};")
    w("\t\t};")
    w("/* End XCSwiftPackageProductDependency section */")

    w("\t};")
    w(f"\trootObject = {ids['project']} /* Project object */;")
    w("}")

    # ── Write ────────────────────────────────────────────────────────────────
    proj_dir = os.path.join(IOS_DIR, f"{PROJECT_NAME}.xcodeproj")
    if os.path.isdir(proj_dir):
        shutil.rmtree(proj_dir)
    os.makedirs(os.path.join(proj_dir, "xcshareddata", "xcschemes"), exist_ok=True)

    with open(os.path.join(proj_dir, "project.pbxproj"), "w") as f:
        f.write("\n".join(L) + "\n")

    # Shared scheme — CI needs one to select a build target.
    scheme = f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1600" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "{ids['target']}"
               BuildableName = "{PRODUCT_NAME}.app"
               BlueprintName = "{TARGET_NAME}"
               ReferencedContainer = "container:{PROJECT_NAME}.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
      </Testables>
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "{ids['target']}"
            BuildableName = "{PRODUCT_NAME}.app"
            BlueprintName = "{TARGET_NAME}"
            ReferencedContainer = "container:{PROJECT_NAME}.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration = "Release" shouldUseLaunchSchemeArgsEnv = "YES" savedToolIdentifier = "" useCustomWorkingDirectory = "NO" debugDocumentVersioning = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "{ids['target']}"
            BuildableName = "{PRODUCT_NAME}.app"
            BlueprintName = "{TARGET_NAME}"
            ReferencedContainer = "container:{PROJECT_NAME}.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction buildConfiguration = "Release" revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
'''
    with open(os.path.join(proj_dir, "xcshareddata", "xcschemes", f"{TARGET_NAME}.xcscheme"), "w") as f:
        f.write(scheme)

    print(f"Generated {PROJECT_NAME}.xcodeproj")
    print(f"  {len(swift_files)} Swift files")
    for p in swift_files:
        print(f"    {p}")
    print(f"  scheme: {TARGET_NAME} (shared)")
    print(f"  package: {SPM_PRODUCT} exactly {SPM_EXACT_VERSION}")


if __name__ == "__main__":
    main()
