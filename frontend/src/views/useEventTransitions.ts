import { ref, computed, nextTick, type Ref } from 'vue'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import { useEventStore } from '@/stores/events'
import { useAiStore } from '@/stores/ai'
import { useNavigationStore, type EventTab, type EventNavigationState } from '@/stores/navigation'

export interface EventTransitionsOptions {
  route: RouteLocationNormalizedLoaded
  router: Router
  eventId: Ref<string>
  contentRef: Ref<HTMLElement | null>
  isMobile?: Ref<boolean>
  t: (key: string, values?: Record<string, any>) => string
}

export function useEventTransitions({
  route,
  router,
  eventId,
  contentRef,
  isMobile,
  t
}: EventTransitionsOptions) {
  const eventStore = useEventStore()
  const aiStore = useAiStore()
  const navStore = useNavigationStore()

  function getInitialTab(): EventTab {
    const id = (route.params.eventId as string) || ''
    const saved = id ? navStore.getEventPosition(id) : null
    if (saved?.fromTab) {
      if (saved.fromTab === 'ai' && !(isMobile?.value)) {
        aiStore.setDockOpen(true)
        return 'rankings'
      }
      return saved.fromTab
    }
    const tabQuery = route.query.tab as string
    if (tabQuery && ['scout', 'pit', 'schedule', 'whiteboard', 'rankings', 'history', 'scouts', 'ai'].includes(tabQuery)) {
      if (tabQuery === 'ai' && !(isMobile?.value)) {
        aiStore.setDockOpen(true)
        return 'rankings'
      }
      return tabQuery as EventTab
    }
    return 'scout'
  }

  const activeTab = ref<EventTab>(getInitialTab())

  const tabs = computed(() => {
    const baseTabs: Array<{ key: EventTab; label: string }> = [
      { key: 'scout' as const, label: t('event.tab_scout') },
      { key: 'pit' as const, label: t('event.tab_pit') },
      { key: 'schedule' as const, label: t('event.tab_schedule') },
      { key: 'whiteboard' as const, label: t('event.tab_whiteboard') },
      { key: 'rankings' as const, label: t('event.tab_rankings') },
      { key: 'history' as const, label: t('event.tab_history') }
    ]
    if (isMobile?.value) {
      baseTabs.push({ key: 'ai' as const, label: t('event.tab_ai') })
    }
    if (eventStore.isHost) {
      baseTabs.push({ key: 'scouts' as const, label: t('event.tab_scouts') })
    }
    return baseTabs
  })

  function switchTab(newTabKey: EventTab) {
    // Desktop: 'ai' toggles/opens docked Copilot sidebar instead of swapping left main view
    if (newTabKey === 'ai' && !(isMobile?.value)) {
      aiStore.setDockOpen(true)
      return
    }
    if (activeTab.value === newTabKey) return

    router.replace({
      query: {
        ...route.query,
        tab: newTabKey
      }
    })

    if (eventId.value) {
      const tabContent = contentRef.value
      const chatMessages = document.querySelector('.messages-scroll, .chat-messages') as HTMLElement | null
      const tableWrapper = document.querySelector('.table-wrapper') as HTMLElement | null
      navStore.saveEventPosition({
        eventId: eventId.value,
        fromTab: newTabKey,
        contentScrollTop: tabContent ? tabContent.scrollTop : window.scrollY,
        contentScrollLeft: tabContent ? tabContent.scrollLeft : window.scrollX,
        tableScrollLeft: tableWrapper ? tableWrapper.scrollLeft : 0,
        aiChatScrollTop: chatMessages ? chatMessages.scrollTop : null,
        teamNumber: null
      })
    }

    activeTab.value = newTabKey
  }

  function restorePosition(savedPos: EventNavigationState) {
    if (savedPos.fromTab === 'ai' && !(isMobile?.value)) {
      aiStore.setDockOpen(true)
      activeTab.value = 'rankings'
    } else {
      activeTab.value = savedPos.fromTab
    }
    nextTick(() => {
      setTimeout(() => {
        if (contentRef.value && savedPos.contentScrollTop) {
          contentRef.value.scrollTop = savedPos.contentScrollTop
        }
        if (activeTab.value === 'rankings') {
          const tableWrapper = document.querySelector('.table-wrapper') as HTMLElement | null
          if (tableWrapper && savedPos.tableScrollLeft) {
            tableWrapper.scrollLeft = savedPos.tableScrollLeft
          }
          if (savedPos.teamNumber) {
            const targetRow = document.querySelector(`[data-team-row="${savedPos.teamNumber}"]`) as HTMLElement | null
            if (targetRow && !savedPos.contentScrollTop) {
              targetRow.scrollIntoView({ block: 'center' })
            }
          }
        }
      }, 20)
    })
  }

  function saveLeavePosition(toTeamNumber?: number | null) {
    const tabContent = contentRef.value
    const chatMessages = document.querySelector('.messages-scroll, .chat-messages') as HTMLElement | null
    const tableWrapper = document.querySelector('.table-wrapper') as HTMLElement | null
    navStore.saveEventPosition({
      eventId: eventId.value,
      fromTab: activeTab.value,
      contentScrollTop: tabContent ? tabContent.scrollTop : window.scrollY,
      contentScrollLeft: tabContent ? tabContent.scrollLeft : window.scrollX,
      tableScrollLeft: tableWrapper ? tableWrapper.scrollLeft : 0,
      aiChatScrollTop: chatMessages ? chatMessages.scrollTop : null,
      teamNumber: toTeamNumber ? Number(toTeamNumber) : null
    })
  }

  return {
    activeTab,
    tabs,
    switchTab,
    restorePosition,
    saveLeavePosition
  }
}
