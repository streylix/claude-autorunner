================================================================================
AUTO-INJECTOR FRONTEND FUNCTION ANALYSIS
================================================================================

📊 SUMMARY:
   • Total Functions: 908
   • Total Lines: 15054
   • Average Lines per Function: 16.6

📁 MAIN.JS
------------------------------------------------------------

🔧 FUNCTION FUNCTIONS (7):
   • setupIpcHandlers
     Lines 315-1009 (695 lines)
     Purpose: Event handling and callbacks

   • createTray
     Lines 122-189 (68 lines)
     Purpose: Initialization and setup

   • createWindow
     Lines 191-242 (52 lines)
     Purpose: Initialization and setup

   • getIcon
     Lines 54-82 (29 lines)
     Purpose: Event handling and callbacks

   • showNotification
     Lines 245-271 (27 lines)
     Purpose: User interface management

   • initDataStorage
     Lines 84-94 (11 lines)
     Purpose: Data persistence and storage

   • safeLog
     Lines 17-25 (9 lines)
     Purpose: General application logic


🔧 ASYNC FUNCTIONS (2):
   • readDataFile
     Lines 96-109 (14 lines)
     Purpose: Data persistence and storage

   • writeDataFile
     Lines 111-119 (9 lines)
     Purpose: Data persistence and storage


📁 RENDERER.JS
------------------------------------------------------------

🔧 CONSTRUCTOR FUNCTIONS (1):
   • constructor [TerminalGUI]
     Lines 13-171 (159 lines)
     Purpose: Constructor for TerminalGUI


🔧 METHOD FUNCTIONS (814):
   • setupEventListeners [TerminalGUI]
     Lines 636-1306 (671 lines)
     Purpose: Event handling and callbacks

   • setupTerminalSearchListeners [TerminalGUI]
     Lines 4948-5093 (146 lines)
     Purpose: Terminal operations and process management

   • updateMessageList [TerminalGUI]
     Lines 1837-1980 (144 lines)
     Purpose: Message queue and injection system

   • detectAutoContinuePrompt [TerminalGUI]
     Lines 3870-3998 (129 lines)
     Purpose: Event handling and callbacks

   • setupTimerSegmentInteractions [TerminalGUI]
     Lines 2651-2774 (124 lines)
     Purpose: Timer and scheduling functionality

   • createTerminal [TerminalGUI]
     Lines 443-554 (112 lines)
     Purpose: Terminal operations and process management

   • updateTimerUI [TerminalGUI]
     Lines 2460-2571 (112 lines)
     Purpose: User interface management

   • manualInjectNextMessage [TerminalGUI]
     Lines 3428-3532 (105 lines)
     Purpose: Message queue and injection system

   • showUsageLimitModal [TerminalGUI]
     Lines 4425-4511 (87 lines)
     Purpose: User interface management

   • createAdditionalTerminalFromData [TerminalGUI]
     Lines 360-442 (83 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 2366-2444 (79 lines)
     Purpose: General application logic

   • openTimerEditDropdown [TerminalGUI]
     Lines 2572-2650 (79 lines)
     Purpose: Timer and scheduling functionality

   • injectMessageAndContinueQueue [TerminalGUI]
     Lines 2910-2987 (78 lines)
     Purpose: Message queue and injection system

   • processMessage [TerminalGUI]
     Lines 3666-3743 (78 lines)
     Purpose: Message queue and injection system

   • scheduleNextInjection [TerminalGUI]
     Lines 3589-3665 (77 lines)
     Purpose: Message queue and injection system

   • performAutoContinue [TerminalGUI]
     Lines 4045-4121 (77 lines)
     Purpose: Event handling and callbacks

   • showMessageTerminalDropdown [TerminalGUI]
     Lines 7381-7454 (74 lines)
     Purpose: Terminal operations and process management

   • checkTerminalStatesForCompletion [TerminalGUI]
     Lines 7825-7898 (74 lines)
     Purpose: Terminal operations and process management

   • for [TerminalGUI]
     Lines 7826-7897 (72 lines)
     Purpose: General application logic

   • typeMessage [TerminalGUI]
     Lines 3800-3869 (70 lines)
     Purpose: Message queue and injection system

   • scanSingleTerminalStatus [TerminalGUI]
     Lines 3285-3351 (67 lines)
     Purpose: Terminal operations and process management

   • setupManualGenerationControls [TerminalGUI]
     Lines 7717-7783 (67 lines)
     Purpose: Event handling and callbacks

   • cleanupOrphanedTerminalSelectorItems [TerminalGUI]
     Lines 7235-7299 (65 lines)
     Purpose: Terminal operations and process management

   • detectDirectoryFromOutput [TerminalGUI]
     Lines 4172-4235 (64 lines)
     Purpose: General application logic

   • startEditingTerminalTitle [TerminalGUI]
     Lines 7317-7380 (64 lines)
     Purpose: Terminal operations and process management

   • waitForStableReadyState [TerminalGUI]
     Lines 6438-6500 (63 lines)
     Purpose: General application logic

   • showAddTerminalDropdown [TerminalGUI]
     Lines 7077-7138 (62 lines)
     Purpose: Terminal operations and process management

   • checkTerminalForKeywords [TerminalGUI]
     Lines 6060-6118 (59 lines)
     Purpose: Terminal operations and process management

   • processMessageBatch [TerminalGUI]
     Lines 3533-3588 (56 lines)
     Purpose: Message queue and injection system

   • typeMessageToTerminal [TerminalGUI]
     Lines 3744-3799 (56 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 2932-2986 (55 lines)
     Purpose: General application logic

   • resetTimer [TerminalGUI]
     Lines 6334-6382 (49 lines)
     Purpose: Timer and scheduling functionality

   • if [TerminalGUI]
     Lines 7848-7896 (49 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3882-3929 (48 lines)
     Purpose: General application logic

   • handleMessageQueueUpdate [TerminalGUI]
     Lines 5755-5801 (47 lines)
     Purpose: Message queue and injection system

   • performAutoContinue [TerminalGUI]
     Lines 3999-4044 (46 lines)
     Purpose: Event handling and callbacks

   • if [TerminalGUI]
     Lines 717-761 (45 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3884-3928 (45 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5518-5562 (45 lines)
     Purpose: General application logic

   • isTerminalStableAndReady [TerminalGUI]
     Lines 6502-6546 (45 lines)
     Purpose: Terminal operations and process management

   • setupConsoleErrorProtection [TerminalGUI]
     Lines 178-221 (44 lines)
     Purpose: Event handling and callbacks

   • if [TerminalGUI]
     Lines 3542-3585 (44 lines)
     Purpose: General application logic

   • initializeTerminal [TerminalGUI]
     Lines 317-359 (43 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 763-805 (43 lines)
     Purpose: General application logic

   • continueTypingFromPause [TerminalGUI]
     Lines 3186-3228 (43 lines)
     Purpose: Event handling and callbacks

   • if [TerminalGUI]
     Lines 3700-3742 (43 lines)
     Purpose: General application logic

   • updateHistoryModal [TerminalGUI]
     Lines 5111-5152 (42 lines)
     Purpose: User interface management

   • renderTodos [TerminalGUI]
     Lines 8348-8388 (41 lines)
     Purpose: General application logic

   • cancelSequentialInjection [TerminalGUI]
     Lines 3041-3080 (40 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 4192-4231 (40 lines)
     Purpose: General application logic

   • setTerminalStatusDisplay [TerminalGUI]
     Lines 4591-4630 (40 lines)
     Purpose: Terminal operations and process management

   • checkTerminalStabilityForGeneration [TerminalGUI]
     Lines 7938-7977 (40 lines)
     Purpose: Terminal operations and process management

   • handleTerminalStateChangeForTodos [TerminalGUI]
     Lines 7899-7937 (39 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 1887-1924 (38 lines)
     Purpose: General application logic

   • startTimer [TerminalGUI]
     Lines 2272-2309 (38 lines)
     Purpose: Timer and scheduling functionality

   • for [TerminalGUI]
     Lines 4193-4230 (38 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5521-5558 (38 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4593-4629 (37 lines)
     Purpose: General application logic

   • renderLogEntries [TerminalGUI]
     Lines 5907-5943 (37 lines)
     Purpose: General application logic

   • setupSmartTimerInput [TerminalGUI]
     Lines 7608-7644 (37 lines)
     Purpose: Timer and scheduling functionality

   • stopTimer [TerminalGUI]
     Lines 2329-2364 (36 lines)
     Purpose: Timer and scheduling functionality

   • if [TerminalGUI]
     Lines 3549-3584 (36 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 5608-5643 (36 lines)
     Purpose: General application logic

   • processNextQueuedMessage [TerminalGUI]
     Lines 2875-2909 (35 lines)
     Purpose: Message queue and injection system

   • undoFromHistory [TerminalGUI]
     Lines 5153-5187 (35 lines)
     Purpose: General application logic

   • checkTerminalForPrompts [TerminalGUI]
     Lines 6160-6193 (34 lines)
     Purpose: Terminal operations and process management

   • setupTodoEventListeners [TerminalGUI]
     Lines 7683-7716 (34 lines)
     Purpose: Event handling and callbacks

   • updateManualTerminalDropdown [TerminalGUI]
     Lines 8090-8123 (34 lines)
     Purpose: Terminal operations and process management

   • showLessImages [TerminalGUI]
     Lines 1511-1543 (33 lines)
     Purpose: User interface management

   • editMessage [TerminalGUI]
     Lines 2016-2048 (33 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 4197-4229 (33 lines)
     Purpose: General application logic

   • autoFillExecuteInForm [TerminalGUI]
     Lines 4558-4590 (33 lines)
     Purpose: General application logic

   • showTerminalSearch [TerminalGUI]
     Lines 4897-4929 (33 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 5768-5800 (33 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 486-517 (32 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 1388-1419 (32 lines)
     Purpose: General application logic

   • showImagePreview [TerminalGUI]
     Lines 1452-1483 (32 lines)
     Purpose: User interface management

   • if [TerminalGUI]
     Lines 4011-4042 (32 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2209-2239 (31 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4595-4625 (31 lines)
     Purpose: General application logic

   • handleScroll [TerminalGUI]
     Lines 4792-4821 (30 lines)
     Purpose: Event handling and callbacks

   • if [TerminalGUI]
     Lines 5291-5320 (30 lines)
     Purpose: General application logic

   • connectMessageQueueWebSocket [TerminalGUI]
     Lines 5716-5745 (30 lines)
     Purpose: Message queue and injection system

   • removeImagePreview [TerminalGUI]
     Lines 1423-1451 (29 lines)
     Purpose: General application logic

   • resumeInjectionExecution [TerminalGUI]
     Lines 3156-3184 (29 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 3898-3926 (29 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4055-4083 (29 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4142-4170 (29 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6337-6365 (29 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 519-546 (28 lines)
     Purpose: General application logic

   • injectMessageWithPlanModeToTerminal [TerminalGUI]
     Lines 3013-3040 (28 lines)
     Purpose: Terminal operations and process management

   • forceResetInjectionState [TerminalGUI]
     Lines 3105-3132 (28 lines)
     Purpose: Message queue and injection system

   • updateTerminalStatusIndicator [TerminalGUI]
     Lines 3352-3379 (28 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 4092-4119 (28 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4521-4548 (28 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5530-5557 (28 lines)
     Purpose: General application logic

   • addKeywordRule [TerminalGUI]
     Lines 5998-6025 (28 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6467-6494 (28 lines)
     Purpose: General application logic

   • switchToTerminal [TerminalGUI]
     Lines 7154-7181 (28 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 7790-7817 (28 lines)
     Purpose: General application logic

   • setManualGenerationLoading [TerminalGUI]
     Lines 8246-8273 (28 lines)
     Purpose: Event handling and callbacks

   • showAllImages [TerminalGUI]
     Lines 1484-1510 (27 lines)
     Purpose: User interface management

   • retrySafetyCheck [TerminalGUI]
     Lines 3387-3413 (27 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7334-7360 (27 lines)
     Purpose: General application logic

   • closeAllModals [TerminalGUI]
     Lines 7498-7524 (27 lines)
     Purpose: User interface management

   • if [TerminalGUI]
     Lines 2412-2437 (26 lines)
     Purpose: General application logic

   • checkStatusChangeSounds [TerminalGUI]
     Lines 4649-4674 (26 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4988-5013 (26 lines)
     Purpose: General application logic

   • updateTerminalDropdowns [TerminalGUI]
     Lines 7208-7233 (26 lines)
     Purpose: Terminal operations and process management

   • setupTerminalSelectorKeyboard [TerminalGUI]
     Lines 7557-7582 (26 lines)
     Purpose: Terminal operations and process management

   • getDarkTerminalTheme [TerminalGUI]
     Lines 569-593 (25 lines)
     Purpose: Terminal operations and process management

   • getLightTerminalTheme [TerminalGUI]
     Lines 594-618 (25 lines)
     Purpose: Terminal operations and process management

   • injectMessageWithPlanMode [TerminalGUI]
     Lines 2988-3012 (25 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 4203-4227 (25 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 5618-5642 (25 lines)
     Purpose: General application logic

   • checkForPromptDetection [TerminalGUI]
     Lines 6205-6229 (25 lines)
     Purpose: Event handling and callbacks

   • updateManualGenerationUI [TerminalGUI]
     Lines 8166-8190 (25 lines)
     Purpose: User interface management

   • if [TerminalGUI]
     Lines 2212-2235 (24 lines)
     Purpose: General application logic

   • runSafetyCheck [TerminalGUI]
     Lines 3236-3259 (24 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3974-3997 (24 lines)
     Purpose: General application logic

   • restoreTerminalData [TerminalGUI]
     Lines 5567-5590 (24 lines)
     Purpose: Terminal operations and process management

   • updateKeywordRulesDisplay [TerminalGUI]
     Lines 6036-6059 (24 lines)
     Purpose: User interface management

   • if [TerminalGUI]
     Lines 6341-6364 (24 lines)
     Purpose: General application logic

   • updateTerminalButtonVisibility [TerminalGUI]
     Lines 6933-6956 (24 lines)
     Purpose: Terminal operations and process management

   • getCleanTerminalOutput [TerminalGUI]
     Lines 8399-8422 (24 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 2491-2513 (23 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2747-2769 (23 lines)
     Purpose: General application logic

   • pauseInProgressInjection [TerminalGUI]
     Lines 3081-3103 (23 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 4019-4041 (23 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4096-4118 (23 lines)
     Purpose: General application logic

   • updatePromptsModal [TerminalGUI]
     Lines 4859-4881 (23 lines)
     Purpose: User interface management

   • if [TerminalGUI]
     Lines 5018-5040 (23 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6071-6093 (23 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7873-7895 (23 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8250-8272 (23 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2545-2566 (22 lines)
     Purpose: General application logic

   • setTimer [TerminalGUI]
     Lines 2784-2805 (22 lines)
     Purpose: Timer and scheduling functionality

   • if [TerminalGUI]
     Lines 3289-3310 (22 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4599-4620 (22 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7336-7357 (22 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2522-2542 (21 lines)
     Purpose: General application logic

   • validateInjectionState [TerminalGUI]
     Lines 2854-2874 (21 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 3082-3102 (21 lines)
     Purpose: General application logic

   • pauseInjectionExecution [TerminalGUI]
     Lines 3134-3154 (21 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 3820-3840 (21 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5569-5589 (21 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 6207-6227 (21 lines)
     Purpose: General application logic

   • selectManualMode [TerminalGUI]
     Lines 8145-8165 (21 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3206-3225 (20 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4441-4460 (20 lines)
     Purpose: General application logic

   • updateStatusDisplay [TerminalGUI]
     Lines 4675-4694 (20 lines)
     Purpose: User interface management

   • if [TerminalGUI]
     Lines 5294-5313 (20 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5478-5497 (20 lines)
     Purpose: General application logic

   • playCompletionSound [TerminalGUI]
     Lines 6743-6762 (20 lines)
     Purpose: Event handling and callbacks

   • playInjectionSound [TerminalGUI]
     Lines 6763-6782 (20 lines)
     Purpose: Message queue and injection system

   • playPromptedSound [TerminalGUI]
     Lines 6799-6818 (20 lines)
     Purpose: General application logic

   • focusTimerEdit [TerminalGUI]
     Lines 7588-7607 (20 lines)
     Purpose: Timer and scheduling functionality

   • pauseTimer [TerminalGUI]
     Lines 2310-2328 (19 lines)
     Purpose: Timer and scheduling functionality

   • if [TerminalGUI]
     Lines 3487-3505 (19 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4250-4268 (19 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4802-4820 (19 lines)
     Purpose: General application logic

   • createLogElement [TerminalGUI]
     Lines 5944-5962 (19 lines)
     Purpose: User interface management

   • refreshTerminalLayout [TerminalGUI]
     Lines 7039-7057 (19 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 7561-7579 (19 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7876-7894 (19 lines)
     Purpose: General application logic

   • clearImagePreviews [TerminalGUI]
     Lines 1544-1561 (18 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1983-2000 (18 lines)
     Purpose: General application logic

   • while [TerminalGUI]
     Lines 2129-2146 (18 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2877-2894 (18 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3764-3781 (18 lines)
     Purpose: General application logic

   • checkCompletionSoundTrigger [TerminalGUI]
     Lines 4631-4648 (18 lines)
     Purpose: Event handling and callbacks

   • if [TerminalGUI]
     Lines 4656-4673 (18 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4696-4713 (18 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4716-4733 (18 lines)
     Purpose: General application logic

   • hideTerminalSearch [TerminalGUI]
     Lines 4930-4947 (18 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 5624-5641 (18 lines)
     Purpose: General application logic

   • toggleMessagePlanMode [TerminalGUI]
     Lines 7480-7497 (18 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 242-258 (17 lines)
     Purpose: General application logic

   • applyTheme [TerminalGUI]
     Lines 619-635 (17 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 889-905 (17 lines)
     Purpose: General application logic

   • toggleTimerOrInjection [TerminalGUI]
     Lines 2255-2271 (17 lines)
     Purpose: Message queue and injection system

   • switch [TerminalGUI]
     Lines 4603-4619 (17 lines)
     Purpose: General application logic

   • deleteFromHistory [TerminalGUI]
     Lines 5188-5204 (17 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5774-5790 (17 lines)
     Purpose: General application logic

   • logAction [TerminalGUI]
     Lines 5879-5895 (17 lines)
     Purpose: Event handling and callbacks

   • if [TerminalGUI]
     Lines 7590-7606 (17 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7960-7976 (17 lines)
     Purpose: General application logic

   • autoResizeMessageInput [TerminalGUI]
     Lines 2083-2098 (16 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 2164-2179 (16 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2547-2562 (16 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4572-4587 (16 lines)
     Purpose: General application logic

   • setupTrayEventListeners [TerminalGUI]
     Lines 5241-5256 (16 lines)
     Purpose: Event handling and callbacks

   • for [TerminalGUI]
     Lines 5537-5552 (16 lines)
     Purpose: General application logic

   • filterAlphabeticalLines [TerminalGUI]
     Lines 6144-6159 (16 lines)
     Purpose: General application logic

   • checkForKeywordBlocking [TerminalGUI]
     Lines 6230-6245 (16 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6314-6329 (16 lines)
     Purpose: General application logic

   • handleDragStart [TerminalGUI]
     Lines 6549-6564 (16 lines)
     Purpose: Event handling and callbacks

   • playSound [TerminalGUI]
     Lines 6727-6742 (16 lines)
     Purpose: General application logic

   • getNextTerminalForMessage [TerminalGUI]
     Lines 7301-7316 (16 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 7612-7627 (16 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7628-7643 (16 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 319-333 (15 lines)
     Purpose: General application logic

   • saveInPlaceEdit [TerminalGUI]
     Lines 2058-2072 (15 lines)
     Purpose: Data persistence and storage

   • cancelEdit [TerminalGUI]
     Lines 2111-2125 (15 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3942-3956 (15 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4658-4672 (15 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5919-5933 (15 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6212-6226 (15 lines)
     Purpose: General application logic

   • insertHotkey [TerminalGUI]
     Lines 6422-6436 (15 lines)
     Purpose: General application logic

   • toggleManualTerminalSelector [TerminalGUI]
     Lines 8060-8074 (15 lines)
     Purpose: Terminal operations and process management

   • toggleManualModeSelector [TerminalGUI]
     Lines 8075-8089 (15 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 641-654 (14 lines)
     Purpose: General application logic

   • updateVoiceButtonState [TerminalGUI]
     Lines 1791-1804 (14 lines)
     Purpose: User interface management

   • injectMessages [TerminalGUI]
     Lines 3414-3427 (14 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 3649-3662 (14 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4362-4375 (14 lines)
     Purpose: General application logic

   • toggleTerminalSearch [TerminalGUI]
     Lines 4883-4896 (14 lines)
     Purpose: Terminal operations and process management

   • for [TerminalGUI]
     Lines 5677-5690 (14 lines)
     Purpose: General application logic

   • extractTextBetweenMarkers [TerminalGUI]
     Lines 6130-6143 (14 lines)
     Purpose: General application logic

   • startUsageLimitSync [TerminalGUI]
     Lines 6246-6259 (14 lines)
     Purpose: Initialization and setup

   • updateTerminalOutput [TerminalGUI]
     Lines 6383-6396 (14 lines)
     Purpose: Terminal operations and process management

   • updateRecentDirectories [TerminalGUI]
     Lines 6919-6932 (14 lines)
     Purpose: Utility and helper functions

   • updateMessageTerminal [TerminalGUI]
     Lines 7455-7468 (14 lines)
     Purpose: Terminal operations and process management

   • focusTerminalSelector [TerminalGUI]
     Lines 7543-7556 (14 lines)
     Purpose: Terminal operations and process management

   • extractRelevantOutput [TerminalGUI]
     Lines 8423-8436 (14 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 961-973 (13 lines)
     Purpose: General application logic

   • scanAndUpdateTerminalStatus [TerminalGUI]
     Lines 3272-3284 (13 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 3365-3377 (13 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4766-4778 (13 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 5570-5582 (13 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 6079-6091 (13 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 6104-6116 (13 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6469-6481 (13 lines)
     Purpose: General application logic

   • handleDragOver [TerminalGUI]
     Lines 6565-6577 (13 lines)
     Purpose: Event handling and callbacks

   • cleanupDragState [TerminalGUI]
     Lines 6593-6605 (13 lines)
     Purpose: General application logic

   • while [TerminalGUI]
     Lines 6625-6637 (13 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6663-6675 (13 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6882-6894 (13 lines)
     Purpose: General application logic

   • cycleToNextTerminal [TerminalGUI]
     Lines 7182-7194 (13 lines)
     Purpose: Terminal operations and process management

   • cycleToPreviousTerminal [TerminalGUI]
     Lines 7195-7207 (13 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 7743-7755 (13 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7878-7890 (13 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7944-7956 (13 lines)
     Purpose: General application logic

   • updateManualModeDropdown [TerminalGUI]
     Lines 8124-8136 (13 lines)
     Purpose: Utility and helper functions

   • if [TerminalGUI]
     Lines 8352-8364 (13 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 246-257 (12 lines)
     Purpose: General application logic

   • initializeLucideIcons [TerminalGUI]
     Lines 291-302 (12 lines)
     Purpose: Event handling and callbacks

   • updateMessage [TerminalGUI]
     Lines 2099-2110 (12 lines)
     Purpose: Message queue and injection system

   • updateTimerDisplay [TerminalGUI]
     Lines 2448-2459 (12 lines)
     Purpose: User interface management

   • if [TerminalGUI]
     Lines 2897-2908 (12 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 4969-4980 (12 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5045-5056 (12 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5060-5071 (12 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5540-5551 (12 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 6232-6243 (12 lines)
     Purpose: General application logic

   • handleDrop [TerminalGUI]
     Lines 6578-6589 (12 lines)
     Purpose: Event handling and callbacks

   • reorderMessage [TerminalGUI]
     Lines 6606-6617 (12 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 8171-8182 (12 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 8214-8225 (12 lines)
     Purpose: General application logic

   • toggleAutoContinue [TerminalGUI]
     Lines 1780-1790 (11 lines)
     Purpose: Event handling and callbacks

   • handleMessageUpdate [TerminalGUI]
     Lines 1815-1825 (11 lines)
     Purpose: Message queue and injection system

   • clearQueue [TerminalGUI]
     Lines 1826-1836 (11 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 2493-2503 (11 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3438-3448 (11 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3826-3836 (11 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4021-4031 (11 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4064-4074 (11 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4098-4108 (11 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4719-4729 (11 lines)
     Purpose: General application logic

   • scrollToBottom [TerminalGUI]
     Lines 4822-4832 (11 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4989-4999 (11 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5079-5089 (11 lines)
     Purpose: General application logic

   • handleMessageInjected [TerminalGUI]
     Lines 5802-5812 (11 lines)
     Purpose: Message queue and injection system

   • startMessageQueuePolling [TerminalGUI]
     Lines 5813-5823 (11 lines)
     Purpose: Message queue and injection system

   • updateActionLogDisplay [TerminalGUI]
     Lines 5896-5906 (11 lines)
     Purpose: User interface management

   • getFilteredLogs [TerminalGUI]
     Lines 5963-5973 (11 lines)
     Purpose: Utility and helper functions

   • syncPromptCount [TerminalGUI]
     Lines 6194-6204 (11 lines)
     Purpose: General application logic

   • showHotkeyDropdown [TerminalGUI]
     Lines 6407-6417 (11 lines)
     Purpose: User interface management

   • updateSoundSettingsVisibility [TerminalGUI]
     Lines 6689-6699 (11 lines)
     Purpose: Settings and configuration management

   • if [TerminalGUI]
     Lines 7094-7104 (11 lines)
     Purpose: General application logic

   • hideAddTerminalDropdown [TerminalGUI]
     Lines 7139-7149 (11 lines)
     Purpose: Terminal operations and process management

   • togglePlanMode [TerminalGUI]
     Lines 7469-7479 (11 lines)
     Purpose: General application logic

   • clearQueueWithConfirmation [TerminalGUI]
     Lines 7525-7535 (11 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 7615-7625 (11 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7631-7641 (11 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8150-8160 (11 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8468-8478 (11 lines)
     Purpose: General application logic

   • filterTodos [TerminalGUI]
     Lines 8510-8520 (11 lines)
     Purpose: General application logic

   • directLog [TerminalGUI]
     Lines 223-232 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1533-1542 (10 lines)
     Purpose: General application logic

   • validateMessageIds [TerminalGUI]
     Lines 1565-1574 (10 lines)
     Purpose: Message queue and injection system

   • updateAutoContinueButtonState [TerminalGUI]
     Lines 1760-1769 (10 lines)
     Purpose: User interface management

   • updatePlanModeButtonState [TerminalGUI]
     Lines 1770-1779 (10 lines)
     Purpose: User interface management

   • updateAutoContinueButtonState [TerminalGUI]
     Lines 1805-1814 (10 lines)
     Purpose: User interface management

   • if [TerminalGUI]
     Lines 1911-1920 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2112-2121 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2261-2270 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2475-2484 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2973-2982 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3963-3972 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4216-4225 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4524-4533 (10 lines)
     Purpose: General application logic

   • openDirectoryPrompt [TerminalGUI]
     Lines 4751-4760 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5449-5458 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5483-5492 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5507-5516 (10 lines)
     Purpose: General application logic

   • clearLogSearch [TerminalGUI]
     Lines 5978-5987 (10 lines)
     Purpose: General application logic

   • removeKeywordRule [TerminalGUI]
     Lines 6026-6035 (10 lines)
     Purpose: General application logic

   • stripAnsiCodes [TerminalGUI]
     Lines 6120-6129 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6946-6955 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7364-7373 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7484-7493 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7546-7555 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8064-8073 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8079-8088 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8172-8181 (10 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8215-8224 (10 lines)
     Purpose: General application logic

   • getTerminalNumberFromSession [TerminalGUI]
     Lines 8389-8398 (10 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 293-301 (9 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 321-329 (9 lines)
     Purpose: General application logic

   • getTerminalTheme [TerminalGUI]
     Lines 560-568 (9 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 668-676 (9 lines)
     Purpose: General application logic

   • stopRecording [TerminalGUI]
     Lines 1713-1721 (9 lines)
     Purpose: Voice transcription and audio processing

   • if [TerminalGUI]
     Lines 1827-1835 (9 lines)
     Purpose: General application logic

   • handleInPlaceEditKeydown [TerminalGUI]
     Lines 2049-2057 (9 lines)
     Purpose: Event handling and callbacks

   • if [TerminalGUI]
     Lines 2101-2109 (9 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2167-2175 (9 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2380-2388 (9 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3334-3342 (9 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3396-3404 (9 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3628-3636 (9 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4971-4979 (9 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5213-5221 (9 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5228-5236 (9 lines)
     Purpose: General application logic

   • handleMessageQueueWebSocketEvent [TerminalGUI]
     Lines 5746-5754 (9 lines)
     Purpose: Message queue and injection system

   • for [TerminalGUI]
     Lines 5839-5847 (9 lines)
     Purpose: General application logic

   • clearActionLog [TerminalGUI]
     Lines 5988-5996 (9 lines)
     Purpose: Event handling and callbacks

   • if [TerminalGUI]
     Lines 6217-6225 (9 lines)
     Purpose: General application logic

   • toggleHotkeyDropdown [TerminalGUI]
     Lines 6398-6406 (9 lines)
     Purpose: General application logic

   • testCompletionSound [TerminalGUI]
     Lines 6700-6708 (9 lines)
     Purpose: Event handling and callbacks

   • testInjectionSound [TerminalGUI]
     Lines 6709-6717 (9 lines)
     Purpose: Message queue and injection system

   • testPromptedSound [TerminalGUI]
     Lines 6718-6726 (9 lines)
     Purpose: General application logic

   • toggleTerminalSelectorDropdown [TerminalGUI]
     Lines 7059-7067 (9 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 7345-7353 (9 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 205-212 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 985-992 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1431-1438 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1795-1802 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1986-1993 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2060-2067 (8 lines)
     Purpose: General application logic

   • disableAutoSync [TerminalGUI]
     Lines 2806-2813 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3198-3205 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3556-3563 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3574-3581 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3770-3777 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3850-3857 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3858-3865 (8 lines)
     Purpose: General application logic

   • handleTerminalOutput [TerminalGUI]
     Lines 4784-4791 (8 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 4861-4868 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5113-5120 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5593-5600 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5682-5689 (8 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5897-5904 (8 lines)
     Purpose: General application logic

   • selectManualTerminal [TerminalGUI]
     Lines 8137-8144 (8 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 322-328 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 525-531 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 976-982 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1062-1068 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1620-1626 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1714-1720 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1762-1768 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1772-1778 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1807-1813 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1818-1824 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2050-2056 (7 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 2227-2233 (7 lines)
     Purpose: General application logic

   • toggleTimer [TerminalGUI]
     Lines 2248-2254 (7 lines)
     Purpose: Timer and scheduling functionality

   • if [TerminalGUI]
     Lines 2286-2292 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2320-2326 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2708-2714 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3370-3376 (7 lines)
     Purpose: General application logic

   • scanTerminalStatus [TerminalGUI]
     Lines 3380-3386 (7 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 3791-3797 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3981-3987 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4218-4224 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4525-4531 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4550-4556 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4661-4667 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4889-4895 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5645-5651 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5805-5811 (7 lines)
     Purpose: General application logic

   • stopMessageQueuePolling [TerminalGUI]
     Lines 5824-5830 (7 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 5867-5873 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5980-5986 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6028-6034 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6570-6576 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6649-6655 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6948-6954 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7273-7279 (7 lines)
     Purpose: General application logic

   • focusSearchInput [TerminalGUI]
     Lines 7536-7542 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7757-7763 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7764-7770 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8253-8259 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8264-8270 (7 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 670-675 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 848-853 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 966-971 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1017-1022 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1440-1445 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1796-1801 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1941-1946 (6 lines)
     Purpose: General application logic

   • cancelInPlaceEdit [TerminalGUI]
     Lines 2073-2078 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2115-2120 (6 lines)
     Purpose: General application logic

   • updateMessageHistoryDisplay [TerminalGUI]
     Lines 2199-2204 (6 lines)
     Purpose: User interface management

   • clearMessageHistory [TerminalGUI]
     Lines 2241-2246 (6 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 2821-2826 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2828-2833 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3177-3182 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3218-3223 (6 lines)
     Purpose: General application logic

   • startTerminalStatusScanning [TerminalGUI]
     Lines 3260-3265 (6 lines)
     Purpose: Terminal operations and process management

   • stopTerminalStatusScanning [TerminalGUI]
     Lines 3266-3271 (6 lines)
     Purpose: Terminal operations and process management

   • for [TerminalGUI]
     Lines 3296-3301 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3670-3675 (6 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 3757-3762 (6 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 3813-3818 (6 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 4183-4188 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4207-4212 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4394-4399 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4404-4409 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4640-4645 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4738-4743 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4826-4831 (6 lines)
     Purpose: General application logic

   • showModal [TerminalGUI]
     Lines 5099-5104 (6 lines)
     Purpose: User interface management

   • closeModal [TerminalGUI]
     Lines 5105-5110 (6 lines)
     Purpose: User interface management

   • if [TerminalGUI]
     Lines 5215-5220 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5230-5235 (6 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 5758-5763 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5794-5799 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5841-5846 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6237-6242 (6 lines)
     Purpose: General application logic

   • stopUsageLimitSync [TerminalGUI]
     Lines 6260-6265 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6272-6277 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6488-6493 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6532-6537 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6981-6986 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6996-7001 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7347-7352 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7619-7624 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7635-7640 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7710-7715 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7721-7726 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7730-7735 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7745-7750 (6 lines)
     Purpose: General application logic

   • startTerminalStateMonitoring [TerminalGUI]
     Lines 7819-7824 (6 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 8050-8055 (6 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 8406-8411 (6 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 501-505 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 541-545 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 548-552 (5 lines)
     Purpose: General application logic

   • resizeAllTerminals [TerminalGUI]
     Lines 555-559 (5 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 623-627 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 659-663 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 719-723 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1037-1041 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1048-1052 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1301-1305 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1340-1344 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1365-1369 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1474-1478 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1675-1679 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1763-1767 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1773-1777 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1785-1789 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1808-1812 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2093-2097 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2133-2137 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2249-2253 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2262-2266 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2689-2693 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2699-2703 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2732-2736 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2757-2761 (5 lines)
     Purpose: General application logic

   • closeTimerDropdownOnOutsideClick [TerminalGUI]
     Lines 2779-2783 (5 lines)
     Purpose: Timer and scheduling functionality

   • performSafetyChecks [TerminalGUI]
     Lines 3231-3235 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3239-3243 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3246-3250 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3251-3255 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3389-3393 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3498-3502 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3514-3518 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3639-3643 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3692-3696 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4258-4262 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4285-4289 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4348-4352 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4450-4454 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4468-4472 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4495-4499 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4500-4504 (5 lines)
     Purpose: General application logic

   • openMessageHistoryModal [TerminalGUI]
     Lines 4841-4845 (5 lines)
     Purpose: User interface management

   • openPromptsModal [TerminalGUI]
     Lines 4850-4854 (5 lines)
     Purpose: User interface management

   • if [TerminalGUI]
     Lines 4916-4920 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4924-4928 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5000-5004 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5084-5088 (5 lines)
     Purpose: General application logic

   • escapeHtml [TerminalGUI]
     Lines 5205-5209 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5245-5249 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5261-5265 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5749-5753 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5825-5829 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5954-5958 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6292-6296 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6449-6453 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6476-6480 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6524-6528 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6583-6587 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6679-6683 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6694-6698 (5 lines)
     Purpose: General application logic

   • onAutoInjectionComplete [TerminalGUI]
     Lines 6819-6823 (5 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 7062-7066 (5 lines)
     Purpose: General application logic

   • showTerminalSelectorDropdown [TerminalGUI]
     Lines 7068-7072 (5 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 7123-7127 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7474-7478 (5 lines)
     Purpose: General application logic

   • highlightTerminalItem [TerminalGUI]
     Lines 7583-7587 (5 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 7600-7604 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7885-7889 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8004-8008 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8200-8204 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8239-8243 (5 lines)
     Purpose: General application logic

   • refreshTodos [TerminalGUI]
     Lines 8505-8509 (5 lines)
     Purpose: General application logic

   • escapeHtml [TerminalGUI]
     Lines 8521-8525 (5 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 536-539 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 563-566 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 650-653 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 689-692 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 730-733 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 790-793 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 927-930 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 995-998 (4 lines)
     Purpose: General application logic

   • highlight [TerminalGUI]
     Lines 1307-1310 (4 lines)
     Purpose: General application logic

   • unhighlight [TerminalGUI]
     Lines 1311-1314 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1318-1321 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1325-1328 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1569-1572 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1622-1625 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1662-1665 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1865-1868 (4 lines)
     Purpose: General application logic

   • autoResizeTextarea [TerminalGUI]
     Lines 2079-2082 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2142-2145 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2273-2276 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2278-2281 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2312-2315 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2340-2343 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2348-2351 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2393-2396 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2451-2454 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2467-2470 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2553-2556 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2685-2688 (4 lines)
     Purpose: General application logic

   • closeAllTimerDropdowns [TerminalGUI]
     Lines 2775-2778 (4 lines)
     Purpose: Timer and scheduling functionality

   • if [TerminalGUI]
     Lines 2816-2819 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2913-2916 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3053-3056 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3058-3061 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3063-3066 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3088-3091 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3093-3096 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3115-3118 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3119-3122 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3123-3126 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3139-3142 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3147-3150 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3160-3163 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3164-3167 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3194-3197 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3267-3270 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3356-3359 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3415-3418 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3430-3433 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3444-3447 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3600-3603 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3605-3608 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3845-3848 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3952-3955 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3993-3996 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4027-4030 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4037-4040 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4077-4080 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4104-4107 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4114-4117 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4275-4278 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4485-4488 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4560-4563 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4651-4654 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4663-4666 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4816-4819 (4 lines)
     Purpose: General application logic

   • closeSettingsModal [TerminalGUI]
     Lines 4837-4840 (4 lines)
     Purpose: User interface management

   • closeMessageHistoryModal [TerminalGUI]
     Lines 4846-4849 (4 lines)
     Purpose: User interface management

   • closePromptsModal [TerminalGUI]
     Lines 4855-4858 (4 lines)
     Purpose: User interface management

   • if [TerminalGUI]
     Lines 5157-5160 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5192-5195 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5352-5355 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5361-5364 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5601-5604 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5705-5708 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5759-5762 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5764-5767 (4 lines)
     Purpose: General application logic

   • for [TerminalGUI]
     Lines 5857-5860 (4 lines)
     Purpose: General application logic

   • highlightSearchTerm [TerminalGUI]
     Lines 5974-5977 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6003-6006 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6009-6012 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6261-6264 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6356-6359 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6376-6379 (4 lines)
     Purpose: General application logic

   • hideHotkeyDropdown [TerminalGUI]
     Lines 6418-6421 (4 lines)
     Purpose: User interface management

   • if [TerminalGUI]
     Lines 6456-6459 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6514-6517 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6541-6544 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6702-6705 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6711-6714 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6720-6723 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6790-6793 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6827-6830 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6959-6962 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6964-6967 (4 lines)
     Purpose: General application logic

   • hideTerminalSelectorDropdown [TerminalGUI]
     Lines 7073-7076 (4 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 7145-7148 (4 lines)
     Purpose: General application logic

   • selectActiveTerminal [TerminalGUI]
     Lines 7150-7153 (4 lines)
     Purpose: Terminal operations and process management

   • if [TerminalGUI]
     Lines 7157-7160 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7264-7267 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7290-7293 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7463-7466 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7526-7529 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7531-7534 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7538-7541 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7551-7554 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7864-7867 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7930-7933 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8042-8045 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8154-8157 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8177-8180 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8186-8189 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8231-8234 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8426-8429 (4 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8449-8452 (4 lines)
     Purpose: General application logic

   • safeAddEventListener [TerminalGUI]
     Lines 173-175 (3 lines)
     Purpose: Event handling and callbacks

   • if [TerminalGUI]
     Lines 225-227 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 270-272 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 274-276 (3 lines)
     Purpose: General application logic

   • formatKeyboardShortcut [TerminalGUI]
     Lines 303-305 (3 lines)
     Purpose: Utility and helper functions

   • isCommandKey [TerminalGUI]
     Lines 307-309 (3 lines)
     Purpose: Terminal operations and process management

   • isTypingInInputField [TerminalGUI]
     Lines 311-313 (3 lines)
     Purpose: General application logic

   • updatePlatformSpecificShortcuts [TerminalGUI]
     Lines 314-316 (3 lines)
     Purpose: Utility and helper functions

   • if [TerminalGUI]
     Lines 355-357 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 431-433 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 629-631 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 801-803 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 988-990 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1105-1107 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1120-1122 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1132-1134 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1149-1151 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1173-1175 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1178-1180 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1252-1254 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1271-1273 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1279-1281 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1347-1349 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1352-1354 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1385-1387 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1442-1444 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1447-1449 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1558-1560 (3 lines)
     Purpose: General application logic

   • generateMessageId [TerminalGUI]
     Lines 1562-1564 (3 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 1584-1586 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1728-1730 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1754-1756 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1859-1861 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 1977-1979 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2004-2006 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2117-2119 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2191-2193 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2385-2387 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2405-2407 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2481-2483 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2568-2570 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2618-2620 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2621-2623 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2802-2804 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2810-2812 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2835-2837 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2841-2843 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2865-2867 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2868-2870 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2871-2873 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 2882-2884 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3171-3173 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3298-3300 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3406-3408 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3591-3593 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3595-3597 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3685-3687 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3693-3695 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3714-3716 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3735-3737 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3945-3947 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 3977-3979 (3 lines)
     Purpose: General application logic

   • getRandomDelay [TerminalGUI]
     Lines 4123-4125 (3 lines)
     Purpose: User interface management

   • if [TerminalGUI]
     Lines 4146-4148 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4185-4187 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4265-4267 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4355-4357 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4545-4547 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4688-4690 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4740-4742 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4788-4790 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4804-4806 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4810-4812 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4910-4912 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4940-4942 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 4996-4998 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5048-5050 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5063-5065 (3 lines)
     Purpose: General application logic

   • isValidMessageContent [TerminalGUI]
     Lines 5095-5097 (3 lines)
     Purpose: Message queue and injection system

   • if [TerminalGUI]
     Lines 5101-5103 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5107-5109 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5336-5338 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5357-5359 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5451-5453 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5508-5510 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5578-5580 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5597-5599 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5609-5611 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5658-5660 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5684-5686 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5691-5693 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5891-5893 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5940-5942 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5964-5966 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 5991-5993 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6062-6064 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6075-6077 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6098-6100 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6121-6123 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6133-6135 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6138-6140 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6167-6169 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6247-6249 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6267-6269 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6304-6306 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6322-6324 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6393-6395 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6483-6485 (3 lines)
     Purpose: General application logic

   • handleDragEnd [TerminalGUI]
     Lines 6590-6592 (3 lines)
     Purpose: Event handling and callbacks

   • if [TerminalGUI]
     Lines 6728-6730 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6744-6746 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6748-6750 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6764-6766 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6768-6770 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6784-6786 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6800-6802 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6804-6806 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6899-6901 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6906-6908 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6926-6928 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6951-6953 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 6983-6985 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7015-7017 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7027-7029 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7112-7114 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7141-7143 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7191-7193 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7204-7206 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7219-7221 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7249-7251 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7304-7306 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7307-7309 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7341-7343 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7384-7386 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7396-7398 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7414-7416 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7433-7435 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7511-7513 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7516-7518 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7521-7523 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7687-7689 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7690-7692 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7695-7697 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7699-7701 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7704-7706 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7738-7740 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7860-7862 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7901-7903 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7921-7923 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7949-7951 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7970-7972 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 7983-7985 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8068-8070 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8083-8085 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8101-8103 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8114-8116 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8133-8135 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8192-8194 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8218-8220 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8256-8258 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8267-8269 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8279-8281 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8289-8291 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8330-8332 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8385-8387 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8392-8394 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8408-8410 (3 lines)
     Purpose: General application logic

   • if [TerminalGUI]
     Lines 8506-8508 (3 lines)
     Purpose: General application logic

   • updatePref [TerminalGUI]
     Lines 177-177 (1 lines)
     Purpose: Utility and helper functions


🔧 ARROW FUNCTIONS (16):
   • performManualInjection [TerminalGUI]
     Lines 3455-3529 (75 lines)
     Purpose: Message queue and injection system

   • checkStatus [TerminalGUI]
     Lines 6445-6497 (53 lines)
     Purpose: General application logic

   • processNext [TerminalGUI]
     Lines 3541-3586 (46 lines)
     Purpose: General application logic

   • saveTitle [TerminalGUI]
     Lines 7331-7361 (31 lines)
     Purpose: Data persistence and storage

   • handleMouseMove [TerminalGUI]
     Lines 2684-2706 (23 lines)
     Purpose: Event handling and callbacks

   • keyHandler [TerminalGUI]
     Lines 7560-7580 (21 lines)
     Purpose: Event handling and callbacks

   • completeInjection [TerminalGUI]
     Lines 3457-3476 (20 lines)
     Purpose: Message queue and injection system

   • handleMouseUp [TerminalGUI]
     Lines 2707-2723 (17 lines)
     Purpose: Event handling and callbacks

   • throttledConsole [TerminalGUI]
     Lines 202-214 (13 lines)
     Purpose: Event handling and callbacks

   • sendNext [TerminalGUI]
     Lines 3825-3837 (13 lines)
     Purpose: General application logic

   • safeConsole [TerminalGUI]
     Lines 185-194 (10 lines)
     Purpose: Event handling and callbacks

   • sendNext [TerminalGUI]
     Lines 3769-3778 (10 lines)
     Purpose: General application logic

   • autoSave [TerminalGUI]
     Lines 2655-2663 (9 lines)
     Purpose: Data persistence and storage

   • closeHandler [TerminalGUI]
     Lines 2639-2646 (8 lines)
     Purpose: Event handling and callbacks

   • handleEscape [TerminalGUI]
     Lines 1473-1479 (7 lines)
     Purpose: Event handling and callbacks

   • handleChoice [TerminalGUI]
     Lines 4491-4494 (4 lines)
     Purpose: Event handling and callbacks


🔧 ASYNC_METHOD FUNCTIONS (66):
   • loadAllPreferences [TerminalGUI]
     Lines 5270-5413 (144 lines)
     Purpose: Settings and configuration management

   • addMessageToQueue [TerminalGUI]
     Lines 1575-1673 (99 lines)
     Purpose: Message queue and injection system

   • addNewTerminal [TerminalGUI]
     Lines 6825-6918 (94 lines)
     Purpose: Terminal operations and process management

   • decrementTimer [TerminalGUI]
     Lines 2365-2447 (83 lines)
     Purpose: Timer and scheduling functionality

   • closeTerminal [TerminalGUI]
     Lines 6957-7037 (81 lines)
     Purpose: Terminal operations and process management

   • setTimerToUsageLimitReset [TerminalGUI]
     Lines 4236-4312 (77 lines)
     Purpose: Timer and scheduling functionality

   • populateSoundEffects [TerminalGUI]
     Lines 6619-6688 (70 lines)
     Purpose: General application logic

   • loadTerminalState [TerminalGUI]
     Lines 5502-5566 (65 lines)
     Purpose: Terminal operations and process management

   • syncMessagesFromBackend [TerminalGUI]
     Lines 5591-5655 (65 lines)
     Purpose: Message queue and injection system

   • initialize [TerminalGUI]
     Lines 233-290 (58 lines)
     Purpose: Initialization and setup

   • checkAndShowUsageLimitModal [TerminalGUI]
     Lines 4331-4386 (56 lines)
     Purpose: User interface management

   • processFiles [TerminalGUI]
     Lines 1330-1379 (50 lines)
     Purpose: General application logic

   • saveToMessageHistory [TerminalGUI]
     Lines 2151-2198 (48 lines)
     Purpose: Message queue and injection system

   • loadMessagesForTerminal [TerminalGUI]
     Lines 5656-5702 (47 lines)
     Purpose: Terminal operations and process management

   • detectUsageLimit [TerminalGUI]
     Lines 4126-4171 (46 lines)
     Purpose: General application logic

   • handleUsageLimitChoice [TerminalGUI]
     Lines 4512-4557 (46 lines)
     Purpose: Event handling and callbacks

   • addImagePreviews [TerminalGUI]
     Lines 1380-1422 (43 lines)
     Purpose: General application logic

   • saveTerminalState [TerminalGUI]
     Lines 5463-5501 (39 lines)
     Purpose: Terminal operations and process management

   • processRecording [TerminalGUI]
     Lines 1722-1759 (38 lines)
     Purpose: Voice transcription and audio processing

   • startSequentialInjection [TerminalGUI]
     Lines 2815-2852 (38 lines)
     Purpose: Message queue and injection system

   • generateTodosViaBackend [TerminalGUI]
     Lines 7978-8015 (38 lines)
     Purpose: General application logic

   • loadMessageHistory [TerminalGUI]
     Lines 2205-2240 (36 lines)
     Purpose: Message queue and injection system

   • initializeTodoSystem [TerminalGUI]
     Lines 7648-7682 (35 lines)
     Purpose: Initialization and setup

   • switchSidebarView [TerminalGUI]
     Lines 7784-7818 (35 lines)
     Purpose: General application logic

   • startRecording [TerminalGUI]
     Lines 1681-1712 (32 lines)
     Purpose: Voice transcription and audio processing

   • updateSyncedTimer [TerminalGUI]
     Lines 6266-6297 (32 lines)
     Purpose: Timer and scheduling functionality

   • generateTodosViaBackendWithMode [TerminalGUI]
     Lines 8274-8304 (31 lines)
     Purpose: General application logic

   • clearCompletedTodos [TerminalGUI]
     Lines 8458-8486 (29 lines)
     Purpose: General application logic

   • getUsageLimitStatus [TerminalGUI]
     Lines 4392-4419 (28 lines)
     Purpose: Utility and helper functions

   • checkAndMigrateLocalStorageData [TerminalGUI]
     Lines 5853-5878 (26 lines)
     Purpose: Data persistence and storage

   • saveMessageQueue [TerminalGUI]
     Lines 2126-2150 (25 lines)
     Purpose: Message queue and injection system

   • changeDirectory [TerminalGUI]
     Lines 4761-4783 (23 lines)
     Purpose: General application logic

   • loadUsageLimitResetTime [TerminalGUI]
     Lines 6311-6333 (23 lines)
     Purpose: Data persistence and storage

   • syncTerminalSessions [TerminalGUI]
     Lines 5831-5852 (22 lines)
     Purpose: Terminal operations and process management

   • deleteMessage [TerminalGUI]
     Lines 1981-2001 (21 lines)
     Purpose: Message queue and injection system

   • createBackendSession [TerminalGUI]
     Lines 8017-8037 (21 lines)
     Purpose: Event handling and callbacks

   • manualGenerateTodos [TerminalGUI]
     Lines 8039-8059 (21 lines)
     Purpose: General application logic

   • handleManualGeneration [TerminalGUI]
     Lines 8191-8211 (21 lines)
     Purpose: Event handling and callbacks

   • saveStatusToBackend [TerminalGUI]
     Lines 4695-4714 (20 lines)
     Purpose: Data persistence and storage

   • loadStatusFromBackend [TerminalGUI]
     Lines 4715-4734 (20 lines)
     Purpose: Data persistence and storage

   • toggleTodo [TerminalGUI]
     Lines 8437-8456 (20 lines)
     Purpose: General application logic

   • clearUsageLimitTracking [TerminalGUI]
     Lines 4313-4330 (18 lines)
     Purpose: General application logic

   • loadTerminalSessionMapping [TerminalGUI]
     Lines 5445-5462 (18 lines)
     Purpose: Terminal operations and process management

   • clearAllTodos [TerminalGUI]
     Lines 8487-8504 (18 lines)
     Purpose: General application logic

   • generateTodosForAllTerminals [TerminalGUI]
     Lines 8212-8228 (17 lines)
     Purpose: Terminal operations and process management

   • generateTodosForTerminal [TerminalGUI]
     Lines 8229-8245 (17 lines)
     Purpose: Terminal operations and process management

   • openDirectoryBrowser [TerminalGUI]
     Lines 4735-4750 (16 lines)
     Purpose: General application logic

   • showSystemNotification [TerminalGUI]
     Lines 6783-6798 (16 lines)
     Purpose: User interface management

   • startPowerSaveBlocker [TerminalGUI]
     Lines 5211-5225 (15 lines)
     Purpose: Data persistence and storage

   • stopPowerSaveBlocker [TerminalGUI]
     Lines 5226-5240 (15 lines)
     Purpose: Data persistence and storage

   • saveCustomPrompt [TerminalGUI]
     Lines 8306-8320 (15 lines)
     Purpose: Data persistence and storage

   • loadCustomPrompt [TerminalGUI]
     Lines 8322-8336 (15 lines)
     Purpose: Data persistence and storage

   • markMessageAsCancelledInBackend [TerminalGUI]
     Lines 2002-2015 (14 lines)
     Purpose: Message queue and injection system

   • updateTrayBadge [TerminalGUI]
     Lines 5257-5269 (13 lines)
     Purpose: Utility and helper functions

   • saveAllPreferences [TerminalGUI]
     Lines 5420-5432 (13 lines)
     Purpose: Settings and configuration management

   • markMessageAsInjectedInBackend [TerminalGUI]
     Lines 5703-5715 (13 lines)
     Purpose: Message queue and injection system

   • setUsageLimitResetTime [TerminalGUI]
     Lines 6298-6310 (13 lines)
     Purpose: Utility and helper functions

   • saveTerminalSessionMapping [TerminalGUI]
     Lines 5433-5444 (12 lines)
     Purpose: Terminal operations and process management

   • loadTodos [TerminalGUI]
     Lines 8337-8347 (11 lines)
     Purpose: Data persistence and storage

   • handleFileDrop [TerminalGUI]
     Lines 1315-1322 (8 lines)
     Purpose: Event handling and callbacks

   • handleFileSelection [TerminalGUI]
     Lines 1323-1329 (7 lines)
     Purpose: Event handling and callbacks

   • toggleVoiceRecording [TerminalGUI]
     Lines 1674-1680 (7 lines)
     Purpose: Voice transcription and audio processing

   • savePreferences [TerminalGUI]
     Lines 5414-5419 (6 lines)
     Purpose: Settings and configuration management

   • checkAndShowUsageLimitModalDebug [TerminalGUI]
     Lines 4387-4391 (5 lines)
     Purpose: User interface management

   • resetUsageLimitTimer [TerminalGUI]
     Lines 4420-4424 (5 lines)
     Purpose: Timer and scheduling functionality

   • openSettingsModal [TerminalGUI]
     Lines 4833-4836 (4 lines)
     Purpose: User interface management


🔧 FUNCTION FUNCTIONS (2):
   • updateMatchDisplay [TerminalGUI]
     Lines 4987-5014 (28 lines)
     Purpose: User interface management

   • countMatches [TerminalGUI]
     Lines 4962-4986 (25 lines)
     Purpose: General application logic


🎯 FUNCTIONS BY PURPOSE:
------------------------------------------------------------
Constructor for TerminalGUI: 1 functions, 159 lines
Data persistence and storage: 15 functions, 249 lines
Event handling and callbacks: 40 functions, 2292 lines
General application logic: 664 functions, 6680 lines
Initialization and setup: 5 functions, 227 lines
Message queue and injection system: 49 functions, 1610 lines
Settings and configuration management: 4 functions, 174 lines
Terminal operations and process management: 66 functions, 2109 lines
Timer and scheduling functionality: 16 functions, 637 lines
User interface management: 35 functions, 732 lines
Utility and helper functions: 9 functions, 99 lines
Voice transcription and audio processing: 4 functions, 86 lines

================================================================================
Generated by analyze_functions.py
================================================================================