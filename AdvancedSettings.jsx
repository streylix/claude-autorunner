// EXAMPLE SETTINGS FROM ANOTHER PROJECT FOR INJECTION MANAGER
import React, { useState, useEffect } from 'react';
import { Modal, ItemPresets, ItemComponents } from './Modal';
import { Sun, Moon, Monitor, Settings as SettingsIcon, Logout, User, Bell, Clock, Palette, History } from 'lucide-react';
import ResponsiveModal from './ResponsiveModal';
import api from '../services/api';
import moment from 'moment';
import './AdvancedSettings.css';

function AdvancedSettings({ isOpen, onClose, onLogout, currentUser, onStartTutorial, onShowUpdateNotes, onShowBetaWelcome }) {
  const [timeZone, setTimeZone] = useState(() => {
    const saved = localStorage.getItem('calendar_timezone');
    return saved || 'America/New_York';
  });
  
  const [defaultView, setDefaultView] = useState(() => {
    const saved = localStorage.getItem('calendar_default_view');
    return saved || 'week';
  });
  
  const [appearance, setAppearance] = useState(() => {
    const saved = localStorage.getItem('calendar_appearance');
    return saved || 'system';
  });
  
  
  const [workingHours, setWorkingHours] = useState(() => {
    const saved = localStorage.getItem('calendar_working_hours');
    return saved ? JSON.parse(saved) : { start: '09:00', end: '17:00' };
  });
  
  const [billingInfo, setBillingInfo] = useState(null);
  const [loadingBilling, setLoadingBilling] = useState(false);
  
  // Event history state
  const [eventHistory, setEventHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [selectedHistoryItem, setSelectedHistoryItem] = useState(null);
  const [historyDetailModalOpen, setHistoryDetailModalOpen] = useState(false);
  
  // Developer tools state
  const [debugMessage, setDebugMessage] = useState(null);

  // Apply theme on component mount and listen for system theme changes
  useEffect(() => {
    applyTheme(appearance);
    
    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = () => {
      if (appearance === 'system') {
        applyTheme('system');
      }
    };
    
    mediaQuery.addEventListener('change', handleSystemThemeChange);
    return () => mediaQuery.removeEventListener('change', handleSystemThemeChange);
  }, [appearance]);

  // Fetch billing information when modal opens
  useEffect(() => {
    if (isOpen && currentUser) {
      fetchBillingInfo();
      fetchEventHistory();
    } else if (!isOpen) {
      // Reset detail modal state when settings modal closes
      setHistoryDetailModalOpen(false);
      setSelectedHistoryItem(null);
    }
  }, [isOpen, currentUser]);

  const fetchBillingInfo = async () => {
    console.log('fetchBillingInfo called - isOpen:', isOpen, 'currentUser:', currentUser);
    setLoadingBilling(true);
    try {
      console.log('Making request to /auth/billing-info/');
      const response = await api.get('/auth/billing-info/');
      console.log('Full response:', response);
      console.log('Response status:', response.status);
      console.log('Response data:', response.data);
      // Use the response directly if response.data is undefined
      const billingData = response.data || response;
      console.log('Using billing data:', billingData);
      setBillingInfo(billingData);
    } catch (error) {
      console.error('Error fetching billing info:', error);
      setBillingInfo(null);
    } finally {
      setLoadingBilling(false);
    }
  };

  const fetchEventHistory = async () => {
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const response = await api.getEventHistory();
      if (response.success) {
        setEventHistory(response.history);
      } else {
        setHistoryError(response.error || 'Failed to load event history');
      }
    } catch (error) {
      console.error('Error fetching event history:', error);
      setHistoryError('Failed to load event history');
    } finally {
      setLoadingHistory(false);
    }
  };

  // Handle timezone change
  const handleTimezoneChange = (newTimezone) => {
    setTimeZone(newTimezone);
    localStorage.setItem('calendar_timezone', newTimezone);
  };

  // Handle default view change
  const handleDefaultViewChange = (newView) => {
    setDefaultView(newView);
    localStorage.setItem('calendar_default_view', newView);
  };

  // Handle appearance change
  const handleAppearanceChange = (newAppearance) => {
    setAppearance(newAppearance);
    localStorage.setItem('calendar_appearance', newAppearance);
    
    // Apply theme immediately
    applyTheme(newAppearance);
  };

  // Theme application function
  const applyTheme = (themePreference) => {
    const root = document.documentElement;
    
    if (themePreference === 'system') {
      // Detect system preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', prefersDark ? 'mocha' : 'latte');
    } else {
      root.setAttribute('data-theme', themePreference);
    }
  };


  // Handle working hours change
  const handleWorkingHoursChange = (field, value) => {
    const newHours = { ...workingHours, [field]: value };
    setWorkingHours(newHours);
    localStorage.setItem('calendar_working_hours', JSON.stringify(newHours));
  };

  // Developer function to create test proposal events
  const createTestProposalEvent = async () => {
    try {
      const testDiff = {
        id: `test-${Date.now()}`,
        status: 'pending',
        diff_type: Math.random() > 0.5 ? 'create' : (Math.random() > 0.5 ? 'update' : 'delete'),
        diff_data: {},
        created_at: new Date().toISOString()
      };

      // Generate test event data
      const testEvent = {
        id: `test-event-${Date.now()}`,
        title: `Test Event ${Math.floor(Math.random() * 100)}`,
        start_time: moment().add(Math.floor(Math.random() * 7), 'days').hour(Math.floor(Math.random() * 12) + 9).toISOString(),
        end_time: moment().add(Math.floor(Math.random() * 7), 'days').hour(Math.floor(Math.random() * 12) + 10).toISOString(),
        color: ['#89b4fa', '#a6e3a1', '#fab387', '#f38ba8', '#cba6f7'][Math.floor(Math.random() * 5)],
        description: `Test description for debugging proposal views`,
        all_day: Math.random() > 0.8
      };

      if (testDiff.diff_type === 'create') {
        testDiff.diff_data = {
          event: testEvent
        };
      } else if (testDiff.diff_type === 'update') {
        const originalEvent = { ...testEvent };
        originalEvent.title = `Original ${originalEvent.title}`;
        originalEvent.color = '#6c7086';
        testDiff.diff_data = {
          event: testEvent,
          original_event: originalEvent
        };
        testDiff.original_events = [originalEvent];
      } else if (testDiff.diff_type === 'delete') {
        testDiff.diff_data = {
          event: testEvent
        };
        testDiff.original_events = [testEvent];
      }

      // Create a simulated diff by posting to a debug endpoint or just show success message
      // Since we don't have a direct diff creation endpoint, we'll simulate it
      console.log('Test diff created:', testDiff);
      
      setDebugMessage(`Test ${testDiff.diff_type} proposal event created successfully!`);
      
      // Clear message after 3 seconds
      setTimeout(() => setDebugMessage(null), 3000);
    } catch (error) {
      console.error('Error creating test proposal:', error);
      setDebugMessage('Failed to create test proposal event');
      setTimeout(() => setDebugMessage(null), 3000);
    }
  };

  // Test notification function
  const testNotification = async () => {
    try {
      const { default: notificationService } = await import('../services/notificationService');
      const success = await notificationService.testNotification();
      
      if (success) {
        setDebugMessage('Test notification sent successfully!');
      } else {
        setDebugMessage('Test notification failed - check browser permissions');
      }
      
      setTimeout(() => setDebugMessage(null), 3000);
    } catch (error) {
      console.error('Error testing notification:', error);
      setDebugMessage('Failed to test notification');
      setTimeout(() => setDebugMessage(null), 3000);
    }
  };

  const settingsSections = [
    {
      label: 'General',
      items: [
        {
          content: <ItemPresets.SUBSECTION title="Calendar Settings">
            <ItemPresets.TEXT_DROPDOWN
              label="Default View"
              subtext="Choose the default calendar view when the app loads"
              value={defaultView}
              options={[
                { value: 'day', label: 'Day View' },
                { value: 'week', label: 'Week View' },
                { value: 'month', label: 'Month View' },
                { value: 'agenda', label: 'Agenda View' }
              ]}
              onChange={handleDefaultViewChange}
            />
            <ItemPresets.TEXT_DROPDOWN
              label="Timezone"
              subtext="Select your timezone for event display"
              value={timeZone}
              options={[
                { value: 'America/New_York', label: 'Eastern Time (EST/EDT)' },
                { value: 'America/Chicago', label: 'Central Time (CST/CDT)' },
                { value: 'America/Denver', label: 'Mountain Time (MST/MDT)' },
                { value: 'America/Los_Angeles', label: 'Pacific Time (PST/PDT)' },
                { value: 'UTC', label: 'UTC' },
                { value: 'Europe/London', label: 'London (GMT/BST)' },
                { value: 'Europe/Paris', label: 'Paris (CET/CEST)' },
                { value: 'Asia/Tokyo', label: 'Tokyo (JST)' }
              ]}
              onChange={handleTimezoneChange}
            />
            <ItemPresets.TEXT_DROPDOWN
              label="Appearance"
              subtext="Choose your preferred appearance mode"
              value={appearance}
              options={[
                { value: 'system', label: 'System' },
                { value: 'mocha', label: 'Mocha (Dark)' },
                { value: 'latte', label: 'Latte (Light)' }
              ]}
              onChange={handleAppearanceChange}
            />
          </ItemPresets.SUBSECTION>
        },
      ]
    },
    // {
    //   label: 'Working Hours',
    //   items: [
    //     {
    //       content: <ItemPresets.SUBSECTION title="Business Hours">
    //         <ItemComponents.CONTAINER>
    //           <ItemComponents.TEXT 
    //             label="Start Time" 
    //             subtext="When your work day typically begins"
    //           />
    //           <input
    //             type="time"
    //             value={workingHours.start}
    //             onChange={(e) => handleWorkingHoursChange('start', e.target.value)}
    //             style={{
    //               padding: '8px 12px',
    //               border: '1px solid var(--border-primary, #313244)',
    //               borderRadius: '6px',
    //               background: 'var(--bg-surface, #181825)',
    //               color: 'var(--text-primary, #cdd6f4)'
    //             }}
    //           />
    //         </ItemComponents.CONTAINER>
    //         <ItemComponents.CONTAINER>
    //           <ItemComponents.TEXT 
    //             label="End Time" 
    //             subtext="When your work day typically ends"
    //           />
    //           <input
    //             type="time"
    //             value={workingHours.end}
    //             onChange={(e) => handleWorkingHoursChange('end', e.target.value)}
    //             style={{
    //               padding: '8px 12px',
    //               border: '1px solid var(--border-primary, #313244)',
    //               borderRadius: '6px',
    //               background: 'var(--bg-surface, #181825)',
    //               color: 'var(--text-primary, #cdd6f4)'
    //             }}
    //           />
    //         </ItemComponents.CONTAINER>
    //       </ItemPresets.SUBSECTION>
    //     }
    //   ]
    // },
    {
      label: 'Billing',
      items: [
        {
          content: <ItemPresets.SUBSECTION title="Usage">
            {loadingBilling ? (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <span className="loading-text" style={{ fontSize: '14px' }}>Loading usage data...</span>
              </div>
            ) : billingInfo ? (
              <div style={{ display: 'flex', gap: '16px', flexDirection: 'column' }}>
                {/* Advanced Requests (Claude) */}
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span className="usage-title" style={{ fontSize: '14px', fontWeight: '500' }}>Calendar Modification Requests</span>
                    <span className="usage-stats" style={{ fontSize: '12px' }}>
                      {billingInfo.advanced_usage.calls_made} / {billingInfo.advanced_usage.calls_limit}
                    </span>
                  </div>
                  <div className="usage-progress-bg" style={{ 
                    width: '100%', 
                    height: '8px', 
                    borderRadius: '4px',
                    overflow: 'hidden'
                  }}>
                    <div style={{ 
                      width: `${billingInfo.advanced_usage.usage_percentage}%`, 
                      height: '100%', 
                      backgroundColor: billingInfo.advanced_usage.usage_percentage > 80 ? '#f38ba8' : billingInfo.advanced_usage.usage_percentage > 60 ? '#fab387' : '#a6e3a1',
                      borderRadius: '4px',
                      transition: 'width 0.3s ease'
                    }} />
                  </div>
                  <div className="usage-remaining" style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', fontSize: '12px' }}>
                    <span>{billingInfo.advanced_usage.calls_remaining} calls remaining</span>
                    <span>Resets in {billingInfo.interval.resets_in}</span>
                  </div>
                </div>

                {/* Basic Requests (ChatGPT) */}
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span className="usage-title" style={{ fontSize: '14px', fontWeight: '500' }}>Basic Requests</span>
                    <span className="usage-stats" style={{ fontSize: '12px' }}>
                      {billingInfo.basic_usage.calls_made} / {billingInfo.basic_usage.calls_limit}
                    </span>
                  </div>
                  <div className="usage-progress-bg" style={{ 
                    width: '100%', 
                    height: '8px', 
                    borderRadius: '4px',
                    overflow: 'hidden'
                  }}>
                    <div style={{ 
                      width: `${billingInfo.basic_usage.usage_percentage}%`, 
                      height: '100%', 
                      backgroundColor: billingInfo.basic_usage.usage_percentage > 80 ? '#f38ba8' : billingInfo.basic_usage.usage_percentage > 60 ? '#fab387' : '#89b4fa',
                      borderRadius: '4px',
                      transition: 'width 0.3s ease'
                    }} />
                  </div>
                  <div className="usage-remaining" style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', fontSize: '12px' }}>
                    <span>{billingInfo.basic_usage.calls_remaining} calls remaining</span>
                    <span>Resets in {billingInfo.interval.resets_in}</span>
                  </div>
                </div>

                {/* Warning for limits reached */}
                {(!billingInfo.advanced_usage.can_make_calls || !billingInfo.basic_usage.can_make_calls) && (
                  <div className="warning-box" style={{ 
                    padding: '12px', 
                    borderRadius: '6px',
                    fontSize: '14px'
                  }}>
                    ⚠️ You've reached your usage limit for {!billingInfo.advanced_usage.can_make_calls && !billingInfo.basic_usage.can_make_calls ? 'both request types' : !billingInfo.advanced_usage.can_make_calls ? 'Advanced Requests' : 'Basic Requests'}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <span className="error-text" style={{ fontSize: '14px' }}>Failed to load usage data</span>
              </div>
            )}
          </ItemPresets.SUBSECTION>
        },
        {
          content: <ItemPresets.SUBSECTION title="Plan Information">
            {billingInfo ? (
              <>
                <ItemComponents.CONTAINER>
                  <ItemComponents.TEXT 
                    label="Current Plan" 
                    subtext={`${billingInfo.tier.display_name} Plan${billingInfo.tier.is_free ? ' - Free' : ''}`}
                  />
                </ItemComponents.CONTAINER>
                
                <ItemComponents.CONTAINER>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary, #a6adc8)', marginBottom: '8px' }}>
                    {billingInfo.tier.is_free ? 
                      'Plan Limits:' :
                      'Unlimited access to all features'
                    }
                  </div>
                  {billingInfo.tier.is_free && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginRight: '8px' }}>
                      <div style={{ fontSize: '12px', color: '#a6adc8', textAlign: 'right' }}>
                        {billingInfo.advanced_usage.calls_limit} Advanced requests per {billingInfo.interval.duration_hours} hours •
                      </div>
                      <div style={{ fontSize: '12px', color: '#a6adc8', textAlign: 'right' }}>
                        {billingInfo.basic_usage.calls_limit} Basic requests per {billingInfo.interval.duration_hours} hours •
                      </div>
                    </div>
                  )}
                </ItemComponents.CONTAINER>

                {(billingInfo.advanced_usage.last_call || billingInfo.basic_usage.last_call) && (
                  <ItemComponents.CONTAINER>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary, #a6adc8)', marginBottom: '8px' }}>
                      Last Requests:
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginRight: '8px' }}>
                      <div style={{ fontSize: '12px', color: '#a6adc8', textAlign: 'right' }}>
                        Advanced: {billingInfo.advanced_usage.last_call ? new Date(billingInfo.advanced_usage.last_call).toLocaleString() : 'Never'} •
                      </div>
                      <div style={{ fontSize: '12px', color: '#a6adc8', textAlign: 'right' }}>
                        Basic: {billingInfo.basic_usage.last_call ? new Date(billingInfo.basic_usage.last_call).toLocaleString() : 'Never'} •
                      </div>
                    </div>
                  </ItemComponents.CONTAINER>
                )}
              </>
            ) : (
              <div style={{ padding: '12px', color: '#a6adc8', fontSize: '14px' }}>
                Plan information unavailable
              </div>
            )}
            {billingInfo && billingInfo.tier.is_free && (
              <ItemPresets.TEXT_BUTTON
                label="Upgrade Plan"
                subtext="Get more advanced requests by upgrading your plan"
                buttonText="Upgrade"
                primary="primary"
                onClick={() => console.log('Upgrade plan')}
              />
            )}
          </ItemPresets.SUBSECTION>
        },
        {
          content: <ItemPresets.SUBSECTION title="Features">
            <ItemComponents.CONTAINER>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {billingInfo && billingInfo.features && Object.entries(billingInfo.features).map(([feature, enabled]) => (
                  <div key={feature} style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    padding: '4px 0'
                  }}>
                    <span className="usage-title" style={{ fontSize: '14px' }}>
                      {feature.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </span>
                    <span className={enabled ? 'feature-enabled' : 'feature-disabled'} style={{ 
                      fontSize: '12px',
                      fontWeight: '500'
                    }}>
                      {enabled ? '✓ Enabled' : '✗ Disabled'}
                    </span>
                  </div>
                ))}
              </div>
            </ItemComponents.CONTAINER>
          </ItemPresets.SUBSECTION>
        }
      ]
    },
    {
      label: 'Event History',
      items: [
        {
          content: <ItemPresets.SUBSECTION title="AI Proposed Events">
            {loadingHistory ? (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <span style={{ color: '#a6adc8', fontSize: '14px' }}>Loading event history...</span>
              </div>
            ) : historyError ? (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <span style={{ color: '#f38ba8', fontSize: '14px' }}>Failed to load event history: {historyError}</span>
                <div style={{ marginTop: '8px' }}>
                  <button 
                    onClick={fetchEventHistory}
                    style={{
                      background: 'transparent',
                      border: '1px solid #89b4fa',
                      color: '#89b4fa',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      cursor: 'pointer'
                    }}
                  >
                    Retry
                  </button>
                </div>
              </div>
            ) : eventHistory.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <History size={24} color="#a6adc8" style={{ marginBottom: '8px' }} />
                <div style={{ color: '#a6adc8', fontSize: '14px' }}>
                  No AI calendar operations yet
                </div>
                <div style={{ color: '#6c7086', fontSize: '12px', marginTop: '4px' }}>
                  Event proposals and changes will appear here
                </div>
              </div>
            ) : (
              <div style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                gap: '8px',
                overflow: 'auto',
                padding: '2px'
              }}>
                {eventHistory.slice(0, 50).map((item, index) => {
                  const statusColor = item.status === 'accepted' ? '#a6e3a1' : 
                                     item.status === 'rejected' ? '#f38ba8' : '#fab387';
                  const statusIcon = item.status === 'accepted' ? '✓' : 
                                    item.status === 'rejected' ? '✗' : '⏳';
                  
                  return (
                    <div 
                      key={item.id} 
                      className="event-history-item"
                      data-debug-id={`event-history-item-${item.id}`}
                      onClick={() => {
                        setSelectedHistoryItem(item);
                        setHistoryDetailModalOpen(true);
                      }}
                      style={{
                        padding: '8px 12px',
                        background: '#181825',
                        border: '1px solid #313244',
                        borderRadius: '6px',
                        fontSize: '13px',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = '#1e1e2e';
                        e.currentTarget.style.borderColor = '#45475a';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = '#181825';
                        e.currentTarget.style.borderColor = '#313244';
                      }}
                    >
                      <div style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'center',
                        marginBottom: '4px'
                      }}>
                        <span className="event-summary" style={{ color: '#cdd6f4', fontWeight: '500' }}>
                          {item.summary}
                        </span>
                        <span style={{ 
                          color: statusColor, 
                          fontSize: '12px',
                          fontWeight: '600',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          background: `${statusColor}20`
                        }}>
                          {statusIcon} {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                        </span>
                      </div>
                      
                      <div style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between',
                        fontSize: '11px',
                        color: '#6c7086'
                      }}>
                        <span className="event-details">
                          {item.diff_type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())} Operation
                        </span>
                        <span className="event-timestamp">
                          {moment(item.created_at).fromNow()}
                        </span>
                      </div>
                      
                      {item.status === 'accepted' && item.updated_at !== item.created_at && (
                        <div className="event-timestamp" style={{ 
                          fontSize: '10px', 
                          color: '#a6adc8',
                          marginTop: '2px'
                        }}>
                          Accepted {moment(item.updated_at).fromNow()}
                        </div>
                      )}
                    </div>
                  );
                })}
                
                {eventHistory.length > 50 && (
                  <div style={{ 
                    textAlign: 'center', 
                    padding: '8px',
                    color: '#6c7086',
                    fontSize: '11px'
                  }}>
                    Showing 50 most recent operations
                  </div>
                )}
              </div>
            )}
            
            <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', color: '#6c7086' }}>
                Total operations: {eventHistory.length}
              </span>
              <button 
                onClick={fetchEventHistory}
                style={{
                  background: 'transparent',
                  border: '1px solid #6c7086',
                  color: '#6c7086',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  cursor: 'pointer'
                }}
              >
                Refresh
              </button>
            </div>
          </ItemPresets.SUBSECTION>
        }
      ]
    },
    {
      label: 'Account',
      items: [
        {
          content: <ItemPresets.SUBSECTION title="User Information">
            <ItemComponents.CONTAINER>
              <ItemComponents.TEXT 
                label="Logged in as" 
                subtext={`${currentUser?.username || "unknown"} (${currentUser?.email || "no email"})`}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <User size={20} color="var(--text-secondary, #a6adc8)" />
                <span style={{ color: 'var(--text-primary, #cdd6f4)' }}>
                  {currentUser?.first_name} {currentUser?.last_name}
                </span>
              </div>
            </ItemComponents.CONTAINER>
          </ItemPresets.SUBSECTION>
        },
        {
          content: <ItemPresets.SUBSECTION title="Session">
            <ItemPresets.TEXT_BUTTON
              label="Logout"
              subtext="Sign out of your account"
              buttonText="Logout"
              primary="warning"
              onClick={onLogout}
            />
          </ItemPresets.SUBSECTION>
        }
      ]
    }
  ];

  // Add Developer section only in development mode
  if (process.env.NODE_ENV === 'development') {
    settingsSections.push({
      label: 'Developer',
      items: [
        {
          content: <ItemPresets.SUBSECTION title="Debug Tools">
            {debugMessage && (
              <div style={{ 
                padding: '8px 12px', 
                backgroundColor: debugMessage.includes('Failed') ? 'rgba(243, 139, 168, 0.1)' : 'rgba(166, 227, 161, 0.1)', 
                border: `1px solid ${debugMessage.includes('Failed') ? 'rgba(243, 139, 168, 0.3)' : 'rgba(166, 227, 161, 0.3)'}`,
                borderRadius: '6px',
                fontSize: '12px',
                color: debugMessage.includes('Failed') ? '#f38ba8' : '#a6e3a1',
                marginBottom: '12px'
              }}>
                {debugMessage}
              </div>
            )}
            <ItemPresets.TEXT_BUTTON
              label="Create Test Proposal Event"
              subtext="Generate a random test proposal event for debugging the proposal views"
              buttonText="🧪 Create Test Event"
              primary="secondary"
              onClick={createTestProposalEvent}
              data-debug-id="dev-create-test-proposal"
            />
            <ItemPresets.TEXT_BUTTON
              label="Restart Tutorial"
              subtext="Show the application tutorial again"
              buttonText="🎯 Start Tutorial"
              primary="primary"
              onClick={() => {
                if (onStartTutorial) {
                  onClose();
                  onStartTutorial();
                }
              }}
              data-debug-id="dev-restart-tutorial"
            />
            <ItemPresets.TEXT_BUTTON
              label="Show Update Notes"
              subtext="View the latest features and changes"
              buttonText="📝 What's New"
              primary="secondary"
              onClick={() => {
                if (onShowUpdateNotes) {
                  onClose();
                  onShowUpdateNotes();
                }
              }}
              data-debug-id="dev-show-update-notes"
            />
            <ItemPresets.TEXT_BUTTON
              label="Show Beta Welcome Modal"
              subtext="Test the beta welcome modal that appears for new users"
              buttonText="👋 Show Beta Welcome"
              primary="secondary"
              onClick={() => {
                if (onShowBetaWelcome) {
                  onClose();
                  onShowBetaWelcome();
                }
              }}
              data-debug-id="dev-show-beta-welcome"
            />
            <ItemPresets.TEXT_BUTTON
              label="Test Browser Notifications"
              subtext="Send a test notification to verify notifications are working"
              buttonText="🔔 Test Notification"
              primary="secondary"
              onClick={testNotification}
              data-debug-id="dev-test-notification"
            />
          </ItemPresets.SUBSECTION>
        }
      ]
    });
  }
  
  if (!isOpen) return null;

  return (
    <>
      <ResponsiveModal
        isOpen={isOpen}
        onClose={onClose}
        title="Settings"
        sections={settingsSections}
        size="large"
      />
      
      {/* Event History Detail Modal */}
      {historyDetailModalOpen && selectedHistoryItem && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.8)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 10001, // Higher than settings modal
            animation: 'fadeIn 0.2s ease-out'
          }}
          onClick={(e) => {
            // Stop propagation to prevent affecting the settings modal
            e.stopPropagation();
            // Only close detail modal if clicking the backdrop
            if (e.target === e.currentTarget) {
              setHistoryDetailModalOpen(false);
              setSelectedHistoryItem(null);
            }
          }}
          onMouseDown={(e) => {
            // Prevent clicks from propagating to settings modal
            e.stopPropagation();
          }}
        >
          <div 
            className="event-history-modal"
            style={{
              background: '#1e1e2e',
              borderRadius: '12px',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px #313244',
              maxHeight: '90vh',
              width: '90%',
              maxWidth: '600px',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              border: '1px solid #313244',
              position: 'relative'
            }}
            onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside modal
            onMouseDown={(e) => e.stopPropagation()} // Prevent mouse down events from bubbling
          >
            {/* Modal Header */}
            <div className="modal-header" style={{
              padding: '20px 24px 16px 24px',
              borderBottom: '1px solid #313244',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <h2 className="modal-title" style={{ 
                color: '#cdd6f4', 
                fontSize: '1.25rem', 
                fontWeight: '600',
                margin: 0
              }}>
                Event History Details
              </h2>
              <button
                className="close-button"
                onClick={() => {
                  setHistoryDetailModalOpen(false);
                  setSelectedHistoryItem(null);
                }}
                style={{
                  background: 'rgba(205, 214, 244, 0.1)',
                  border: '1px solid #313244',
                  borderRadius: '50%',
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  color: '#cdd6f4',
                  transition: 'all 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(205, 214, 244, 0.2)';
                  e.currentTarget.style.borderColor = '#89b4fa';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(205, 214, 244, 0.1)';
                  e.currentTarget.style.borderColor = '#313244';
                }}
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div style={{
              padding: '16px 24px',
              overflow: 'auto',
              flex: 1
            }}>
              <ItemPresets.SUBSECTION title={`${selectedHistoryItem.diff_type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())} Operation`}>
                {/* Operation Summary */}
                <div className="summary-box" style={{ marginBottom: '16px', padding: '12px', background: '#181825', borderRadius: '6px' }}>
                  <div className="summary-title" style={{ fontSize: '14px', fontWeight: '600', color: '#cdd6f4', marginBottom: '8px' }}>
                    Summary
                  </div>
                  <div className="summary-text" style={{ fontSize: '13px', color: '#a6adc8' }}>
                    {selectedHistoryItem.summary}
                  </div>
                </div>

                {/* Status */}
                <div style={{ marginBottom: '16px' }}>
                  <div className="status-label" style={{ fontSize: '12px', color: '#6c7086', marginBottom: '4px' }}>Status</div>
                  <div style={{ 
                    display: 'inline-block',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    fontWeight: '600',
                    background: selectedHistoryItem.status === 'accepted' ? '#a6e3a120' : 
                               selectedHistoryItem.status === 'rejected' ? '#f38ba820' : '#fab38720',
                    color: selectedHistoryItem.status === 'accepted' ? '#a6e3a1' : 
                           selectedHistoryItem.status === 'rejected' ? '#f38ba8' : '#fab387'
                  }}>
                    {selectedHistoryItem.status === 'accepted' ? '✓' : selectedHistoryItem.status === 'rejected' ? '✗' : '⏳'} {selectedHistoryItem.status.charAt(0).toUpperCase() + selectedHistoryItem.status.slice(1)}
                  </div>
                </div>

                {/* Timestamps */}
                <div style={{ marginBottom: '16px' }}>
                  <div className="section-header" style={{ fontSize: '12px', color: '#6c7086', marginBottom: '8px' }}>Timeline</div>
                  <div className="timeline-text" style={{ fontSize: '11px', color: '#a6adc8' }}>
                    <div>Created: {moment(selectedHistoryItem.created_at).format('MMMM Do YYYY, h:mm:ss a')} ({moment(selectedHistoryItem.created_at).fromNow()})</div>
                    {selectedHistoryItem.updated_at !== selectedHistoryItem.created_at && (
                      <div>Updated: {moment(selectedHistoryItem.updated_at).format('MMMM Do YYYY, h:mm:ss a')} ({moment(selectedHistoryItem.updated_at).fromNow()})</div>
                    )}
                  </div>
                </div>

                {/* Event Data */}
                {selectedHistoryItem.diff_data && selectedHistoryItem.diff_data.event && (
                  <div style={{ marginBottom: '16px' }}>
                    <div className="section-header" style={{ fontSize: '12px', color: '#6c7086', marginBottom: '8px' }}>Proposed Event</div>
                    <div className="event-details-block" style={{ padding: '8px', background: '#11111b', borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace' }}>
                      <div style={{ color: '#cdd6f4', marginBottom: '4px' }}>
                        <strong>Title:</strong> {selectedHistoryItem.diff_data.event.title || 'N/A'}
                      </div>
                      {selectedHistoryItem.diff_data.event.start_time && (
                        <div style={{ color: '#a6adc8', marginBottom: '2px' }}>
                          <strong>Start:</strong> {moment(selectedHistoryItem.diff_data.event.start_time).format('MMMM Do YYYY, h:mm a')}
                        </div>
                      )}
                      {selectedHistoryItem.diff_data.event.end_time && (
                        <div style={{ color: '#a6adc8', marginBottom: '2px' }}>
                          <strong>End:</strong> {moment(selectedHistoryItem.diff_data.event.end_time).format('MMMM Do YYYY, h:mm a')}
                        </div>
                      )}
                      {selectedHistoryItem.diff_data.event.description && (
                        <div style={{ color: '#89b4fa', marginBottom: '2px' }}>
                          <strong>Description:</strong> {selectedHistoryItem.diff_data.event.description}
                        </div>
                      )}
                      {selectedHistoryItem.diff_data.event.color && (
                        <div style={{ color: '#fab387', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <strong>Color:</strong> 
                          <span style={{ 
                            display: 'inline-block',
                            width: '12px',
                            height: '12px',
                            borderRadius: '50%',
                            background: selectedHistoryItem.diff_data.event.color,
                            border: '1px solid #313244'
                          }}></span>
                          {selectedHistoryItem.diff_data.event.color}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Original Event Data (for updates/deletes) */}
                {selectedHistoryItem.original_events && selectedHistoryItem.original_events.length > 0 && (
                  <div style={{ marginBottom: '16px' }}>
                    <div className="section-header" style={{ fontSize: '12px', color: '#6c7086', marginBottom: '8px' }}>Original Event</div>
                    <div className="event-details-block" style={{ padding: '8px', background: '#11111b', borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace' }}>
                      {selectedHistoryItem.original_events.map((originalEvent, idx) => (
                        <div key={idx}>
                          <div style={{ color: '#f38ba8', marginBottom: '4px' }}>
                            <strong>Title:</strong> {originalEvent.title || 'N/A'}
                          </div>
                          {originalEvent.start_time && (
                            <div style={{ color: '#a6adc8', marginBottom: '2px' }}>
                              <strong>Start:</strong> {moment(originalEvent.start_time).format('MMMM Do YYYY, h:mm a')}
                            </div>
                          )}
                          {originalEvent.end_time && (
                            <div style={{ color: '#a6adc8', marginBottom: '2px' }}>
                              <strong>End:</strong> {moment(originalEvent.end_time).format('MMMM Do YYYY, h:mm a')}
                            </div>
                          )}
                          {originalEvent.description && (
                            <div style={{ color: '#89b4fa', marginBottom: '2px' }}>
                              <strong>Description:</strong> {originalEvent.description}
                            </div>
                          )}
                          {originalEvent.color && (
                            <div style={{ color: '#fab387', display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <strong>Color:</strong> 
                              <span style={{ 
                                display: 'inline-block',
                                width: '12px',
                                height: '12px',
                                borderRadius: '50%',
                                background: originalEvent.color,
                                border: '1px solid #313244'
                              }}></span>
                              {originalEvent.color}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Raw Data (Developer Mode) */}
                {process.env.NODE_ENV === 'development' && (
                  <div>
                    <div style={{ fontSize: '12px', color: '#6c7086', marginBottom: '8px' }}>Raw Data (Dev)</div>
                    <details style={{ fontSize: '10px', fontFamily: 'monospace' }}>
                      <summary style={{ color: '#89b4fa', cursor: 'pointer', userSelect: 'none' }}>Show JSON</summary>
                      <pre style={{ 
                        background: '#11111b', 
                        padding: '8px', 
                        borderRadius: '4px', 
                        color: '#cdd6f4',
                        marginTop: '4px',
                        overflow: 'auto',
                        maxHeight: '200px',
                        userSelect: 'text' // Allow text selection
                      }}>
                        {JSON.stringify(selectedHistoryItem, null, 2)}
                      </pre>
                    </details>
                  </div>
                )}
              </ItemPresets.SUBSECTION>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default AdvancedSettings; 