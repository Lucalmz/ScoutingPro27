import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import RenameModal from '@/components/common/RenameModal.vue'
import { useUserStore } from '@/stores/user'
import { useConnectionStore } from '@/stores/connection'
import { useEventStore } from '@/stores/events'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => {
        const dict: Record<string, string> = {
          'common.cancel': '取消',
          'user.btn_cancel': '取消',
          'user.rename_title': '修改账号资料与密码',
          'user.nickname_label': '用户名 / 昵称',
          'user.btn_save': '保存修改',
          'user.password_mismatch': '两次输入的新密码不一致'
        }
        return dict[key] || key
      }
    })
  }
})

describe('RenameModal.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('renders modal when visible is true and populates current username, showing Cancel button properly', () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice', token: 'tok' }

    const wrapper = mount(RenameModal, {
      props: {
        visible: true,
        eventId: 'evt_1'
      }
    })

    expect(wrapper.find('.modal-title').text()).toContain('修改账号资料与密码')
    const input = wrapper.find<HTMLInputElement>('input.form-input')
    expect(input.element.value).toBe('Alice')

    const cancelBtn = wrapper.find('button.btn-secondary')
    expect(cancelBtn.text()).toBe('取消')
  })

  it('triggers rename with updated username upon save', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice', token: 'tok' }
    vi.spyOn(userStore, 'rename').mockResolvedValue({
      success: true,
      oldId: 'u1',
      newId: 'u2',
      newUsername: 'Alice-88'
    })

    const connStore = useConnectionStore()
    const mockRtc = {
      sendIdentityMigration: vi.fn(),
      requestSync: vi.fn()
    }
    connStore.setRtcService(mockRtc as any)

    const wrapper = mount(RenameModal, {
      props: {
        visible: true,
        eventId: 'evt_100'
      }
    })

    const input = wrapper.find<HTMLInputElement>('input.form-input')
    await input.setValue('Alice-88')

    const saveBtn = wrapper.find('button.btn-primary')
    await saveBtn.trigger('click')

    expect(userStore.rename).toHaveBeenCalledWith({
      newUsername: 'Alice-88',
      oldPassword: undefined,
      newPassword: undefined
    })
    expect(mockRtc.sendIdentityMigration).toHaveBeenCalledWith('evt_100', 'u1', 'u2', 'Alice-88')
    expect(wrapper.emitted('renamed')).toBeTruthy()
    expect(wrapper.emitted('renamed')![0]).toEqual(['Alice-88'])
    expect(wrapper.emitted('update:visible')![0]).toEqual([false])
  })

  it('supports updating password when toggle is checked', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice', token: 'tok' }
    vi.spyOn(userStore, 'rename').mockResolvedValue({
      success: true,
      oldId: 'u1',
      newId: 'u3',
      newUsername: 'Alice'
    })

    const wrapper = mount(RenameModal, {
      props: {
        visible: true
      }
    })

    // Click accordion header to expand password fields
    const accordionHeader = wrapper.find('.accordion-header')
    await accordionHeader.trigger('click')

    const inputs = wrapper.findAll<HTMLInputElement>('input[type="password"]')
    expect(inputs).toHaveLength(3)

    // Fill old password, new password, and confirm password
    await inputs[0]!.setValue('oldSecret123')
    await inputs[1]!.setValue('newSecret456')
    await inputs[2]!.setValue('newSecret456')

    const saveBtn = wrapper.find('button.btn-primary')
    await saveBtn.trigger('click')

    expect(userStore.rename).toHaveBeenCalledWith({
      newUsername: 'Alice',
      oldPassword: 'oldSecret123',
      newPassword: 'newSecret456'
    })
    expect(wrapper.emitted('renamed')).toBeTruthy()
  })
})
