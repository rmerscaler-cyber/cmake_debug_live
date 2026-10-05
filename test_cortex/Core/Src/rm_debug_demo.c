/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file    rm_debug_demo.c
  * @brief   rm_debug extension demo fixture: SBUS remote input, LED modes and
  *          RM2 telemetry over USART1 TX (PA9, 115200 8N1, DMA).
  *
  *          LED (PC13, active low) is selected by remote switch s[2]:
  *            s[2] UP   : existing behaviour, 0.5 -> 5 Hz ramp then steady on
  *            s[2] MID  : software-PWM breathing (TIM4 update interrupt)
  *            s[2] DOWN : fixed 8 Hz fast blink
  *          Without a remote signal the ramp behaviour stays active.
  ******************************************************************************
  */
/* USER CODE END Header */

/* Includes ------------------------------------------------------------------*/
#include "main.h"
#include "usart.h"
#include "tim.h"
#include "remote_control.h"
#include "rm_debug_demo.h"

/* USER CODE BEGIN Includes */
#include <stdio.h>
#include <math.h>

/* USER CODE END Includes */

/* Private define ------------------------------------------------------------*/
#define LED_GPIO_PORT                 GPIOC
#define LED_GPIO_PIN                  GPIO_PIN_13
#define LED_ACTIVE_LEVEL              GPIO_PIN_RESET
#define LED_INACTIVE_LEVEL            GPIO_PIN_SET

#define LED_START_FREQUENCY_HZ        0.5f
#define LED_MAX_FREQUENCY_HZ          5.0f
#define LED_RAMP_DURATION_MS          9000U
#define LED_FREQUENCY_UPDATE_MS       20U
#define RM_TELEMETRY_INTERVAL_MS      20U

/* Software PWM on PC13: TIM4 update rate divided into 100 duty steps. */
#define LED_PWM_TICK_HZ               20000U
#define LED_PWM_STEPS                 100U

#define LED_FAST_BLINK_HZ             8U
#define LED_FAST_BLINK_HALF_MS        (1000U / LED_FAST_BLINK_HZ / 2U)
#define LED_BREATH_PERIOD_MS          1280U
#define LED_BREATH_STEPS              64U

/* Private typedef -----------------------------------------------------------*/
typedef enum
{
  LED_MODE_RAMP = 0,
  LED_MODE_BREATH = 1,
  LED_MODE_FAST_BLINK = 2
} LedMode;

/* Private variables ---------------------------------------------------------*/
/* Current target blink frequency in complete on/off cycles per second.
 * It stays at LED_MAX_FREQUENCY_HZ after the LED becomes steadily on. */
volatile float g_led_blink_frequency_hz = LED_START_FREQUENCY_HZ;

/* Becomes 1 when the frequency ramp is complete and the LED is held on. */
volatile uint8_t g_led_ramp_complete = 0U;

/* Add g_led_debug to Live Watch to inspect scalar, nested and array fields. */
volatile LedDebugSnapshot g_led_debug = {0};

/* Observe these in Live Watch when serial data does not reach the PC. */
volatile uint32_t g_rm_uart_tx_started = 0U;
volatile uint32_t g_rm_uart_tx_completed = 0U;
volatile uint32_t g_rm_uart_tx_failed = 0U;

/* Watch this global pointer to see its current function target change. */
LedTransitionHandler volatile g_led_transition_handler = 0;

/* Private function prototypes -----------------------------------------------*/
static void LED_SetOn(uint8_t is_on);
static void LED_RecordTransition(uint8_t is_on, uint32_t elapsed_ms);
static void LED_RecordTransitionAfterHalfway(uint8_t is_on, uint32_t elapsed_ms);
static void RM_TelemetrySend(uint32_t uptime_ms);
static void LedPwmInit(void);
static void LedBreathTableInit(void);

/* Private user code ---------------------------------------------------------*/
static uint32_t ramp_start_tick;
static uint32_t last_frequency_update_tick;
static uint32_t last_phase_update_tick;
static uint32_t last_monitor_update_tick;
static uint32_t last_history_sample_tick;
static uint32_t last_telemetry_tick;
static uint32_t history_index = 0U;
static uint8_t led_is_on = 0U;

/* Software PWM state, written from the TIM4 update ISR. */
static volatile uint16_t led_pwm_tick = 0U;
static volatile uint16_t led_pwm_duty = 0U;   /* 0..LED_PWM_STEPS */

static LedMode led_mode = LED_MODE_RAMP;
static uint32_t led_mode_start_tick = 0U;
static uint8_t breath_table[LED_BREATH_STEPS];

static void LED_SetOn(uint8_t is_on)
{
  /* The lamp is driven by the TIM4 software PWM; this only sets the logical
   * on/off level. In the ramp mode the level is either full on or full off. */
  led_pwm_duty = is_on ? LED_PWM_STEPS : 0U;
  g_led_debug.pwm_duty = led_pwm_duty;
}

static void LED_RecordTransition(uint8_t is_on, uint32_t elapsed_ms)
{
  uint32_t interval_ms = elapsed_ms - g_led_debug.timing.last_transition_ms;

  LED_SetOn(is_on);
  g_led_debug.led_on = is_on;
  g_led_debug.transition_count++;
  g_led_debug.timing.last_transition_ms = elapsed_ms;
  g_led_debug.timing.last_interval_ms = interval_ms;

  for (uint32_t index = 3U; index > 0U; index--)
  {
    g_led_debug.recent_intervals_ms[index] = g_led_debug.recent_intervals_ms[index - 1U];
  }
  g_led_debug.recent_intervals_ms[0] = interval_ms;
}

static void LED_RecordTransitionAfterHalfway(uint8_t is_on, uint32_t elapsed_ms)
{
  LED_RecordTransition(is_on, elapsed_ms);
}

static void LedBreathTableInit(void)
{
  for (uint32_t i = 0U; i < LED_BREATH_STEPS; i++)
  {
    float phase = 2.0f * 3.14159265f * (float)i / (float)LED_BREATH_STEPS;
    breath_table[i] = (uint8_t)((1.0f - cosf(phase)) * 0.5f * (float)LED_PWM_STEPS + 0.5f);
  }
}

/* TIM4 runs as a 20 kHz time base (no output pin); the update ISR performs the
 * software PWM so PC13 can breathe without a hardware timer channel. */
static void LedPwmInit(void)
{
  __HAL_RCC_TIM4_CLK_ENABLE();
  htim4.Init.Prescaler = 0U;
  htim4.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim4.Init.Period = (72000000U / LED_PWM_TICK_HZ) - 1U;
  htim4.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim4.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_Base_Init(&htim4) != HAL_OK)
  {
    Error_Handler();
  }
  __HAL_TIM_CLEAR_FLAG(&htim4, TIM_FLAG_UPDATE);
  HAL_NVIC_SetPriority(TIM4_IRQn, 1, 0);
  HAL_NVIC_EnableIRQ(TIM4_IRQn);
  if (HAL_TIM_Base_Start_IT(&htim4) != HAL_OK)
  {
    Error_Handler();
  }
}

/* RM2,<uptime ms>,<name=value>,... followed by LF.
 * USART1 TX is PA9 at 115200 8N1. Keep the buffer until DMA completes.
 * Add further variables here when a new serial channel is needed. */
static void RM_TelemetrySend(uint32_t uptime_ms)
{
  static uint8_t tx_buffer[224];
  uint32_t frequency_millihz;
  uint32_t phase_millicycles;
  int length;
  HAL_StatusTypeDef result;

  if (huart1.gState != HAL_UART_STATE_READY) { return; }
  frequency_millihz = (uint32_t)(g_led_debug.blink_frequency_hz * 1000.0f + 0.5f);
  phase_millicycles = (uint32_t)(g_led_debug.timing.phase_cycles * 1000.0f + 0.5f);
  length = snprintf((char *)tx_buffer, sizeof(tx_buffer),
                    "RM2,%lu,g_led_debug.blink_frequency_hz=%lu.%03lu,"
                    "g_led_debug.led_on=%lu,g_led_debug.transition_count=%lu,"
                    "g_led_debug.timing.phase_cycles=%lu.%03lu,"
                    "g_led_debug.led_mode=%lu\n",
                    (unsigned long)uptime_ms,
                    (unsigned long)(frequency_millihz / 1000U),
                    (unsigned long)(frequency_millihz % 1000U),
                    (unsigned long)g_led_debug.led_on,
                    (unsigned long)g_led_debug.transition_count,
                    (unsigned long)(phase_millicycles / 1000U),
                    (unsigned long)(phase_millicycles % 1000U),
                    (unsigned long)g_led_debug.led_mode);
  if (length > 0 && length < (int)sizeof(tx_buffer))
  {
    result = HAL_UART_Transmit_DMA(&huart1, tx_buffer, (uint16_t)length);
    if (result == HAL_OK) { g_rm_uart_tx_started++; }
    else { g_rm_uart_tx_failed++; }
  }
}

void RM_DebugDemoInit(void)
{
  /* PC13 LED boards commonly use an active-low LED; start with it off. */
  LED_GPIO_PORT->BSRR = LED_GPIO_PIN;
  led_pwm_tick = 0U;
  led_pwm_duty = 0U;

  LedBreathTableInit();
  LedPwmInit();

  g_led_blink_frequency_hz = LED_START_FREQUENCY_HZ;
  g_led_ramp_complete = 0U;
  g_led_debug.blink_frequency_hz = LED_START_FREQUENCY_HZ;
  g_led_debug.led_mode = LED_MODE_RAMP;
  g_led_debug.pwm_duty = 0U;
  g_led_transition_handler = LED_RecordTransition;
  g_led_debug.transition_handler = g_led_transition_handler;

  ramp_start_tick = HAL_GetTick();
  last_frequency_update_tick = ramp_start_tick;
  last_phase_update_tick = ramp_start_tick;
  last_monitor_update_tick = ramp_start_tick;
  last_history_sample_tick = ramp_start_tick;
  last_telemetry_tick = ramp_start_tick;
  history_index = 0U;
  led_is_on = 0U;
  led_mode = LED_MODE_RAMP;
  led_mode_start_tick = ramp_start_tick;
  g_led_debug.led_on = 0U;
  g_led_debug.timing.last_transition_ms = 0U;
}

void RM_DebugDemoUpdate(void)
{
  uint32_t now = HAL_GetTick();
  uint32_t elapsed = now - ramp_start_tick;
  const RC_ctrl_t *rc = get_remote_control_point();
  LedMode desired_mode = LED_MODE_RAMP;

  /* s[2] selects the LED effect; without a live remote the ramp stays. */
  if (remote_control_is_online())
  {
    if (switch_is_mid(rc->rc.s[2]))
    {
      desired_mode = LED_MODE_BREATH;
    }
    else if (switch_is_down(rc->rc.s[2]))
    {
      desired_mode = LED_MODE_FAST_BLINK;
    }
  }

  if (desired_mode != led_mode)
  {
    led_mode = desired_mode;
    led_mode_start_tick = now;
    if (led_mode == LED_MODE_RAMP)
    {
      /* Coming back to the ramp effect keeps its result (steady on after the
       * ramp, otherwise the next transition drives the level through the
       * handler). */
      led_pwm_duty = (g_led_ramp_complete != 0U || led_is_on != 0U) ? LED_PWM_STEPS : 0U;
    }
  }
  g_led_debug.led_mode = (uint32_t)led_mode;

  if (now != last_monitor_update_tick)
  {
    g_led_debug.uptime_ms = elapsed;
    last_monitor_update_tick = now;
  }

  if ((now - last_telemetry_tick) >= RM_TELEMETRY_INTERVAL_MS)
  {
    last_telemetry_tick = now;
    RM_TelemetrySend(elapsed);
  }

  while (((now - last_history_sample_tick) >= 25U) && (history_index < 300U))
  {
    last_history_sample_tick += 25U;
    g_led_debug.frequency_history_millihz[history_index] =
        (uint32_t)(g_led_blink_frequency_hz * 1000.0f);
    history_index++;
    g_led_debug.frequency_history_count = history_index;
  }

  switch (led_mode)
  {
    case LED_MODE_BREATH:
    {
      uint32_t phase = (now - led_mode_start_tick) % LED_BREATH_PERIOD_MS;
      uint32_t index = (phase * LED_BREATH_STEPS) / LED_BREATH_PERIOD_MS;

      led_pwm_duty = breath_table[index];
      g_led_debug.led_on = (led_pwm_duty > 0U) ? 1U : 0U;
      g_led_debug.blink_frequency_hz = 0.0f;
      break;
    }

    case LED_MODE_FAST_BLINK:
    {
      uint8_t on = (uint8_t)((((now - led_mode_start_tick) / LED_FAST_BLINK_HALF_MS) & 1U) == 0U);

      led_pwm_duty = on ? LED_PWM_STEPS : 0U;
      if (on != g_led_debug.led_on)
      {
        g_led_debug.led_on = on;
        g_led_debug.transition_count++;
      }
      g_led_debug.blink_frequency_hz = (float)LED_FAST_BLINK_HZ;
      break;
    }

    case LED_MODE_RAMP:
    default:
    {
      if ((elapsed >= (LED_RAMP_DURATION_MS / 2U)) &&
          (g_led_transition_handler != LED_RecordTransitionAfterHalfway))
      {
        g_led_transition_handler = LED_RecordTransitionAfterHalfway;
        g_led_debug.transition_handler = g_led_transition_handler;
      }

      if (g_led_ramp_complete != 0U)
      {
        return;
      }

      if (elapsed >= LED_RAMP_DURATION_MS)
      {
        g_led_blink_frequency_hz = LED_MAX_FREQUENCY_HZ;
        g_led_ramp_complete = 1U;
        g_led_debug.blink_frequency_hz = LED_MAX_FREQUENCY_HZ;
        g_led_debug.steady_on = 1U;
        if (led_is_on == 0U)
        {
          led_is_on = 1U;
          g_led_transition_handler(led_is_on, elapsed);
        }
        return;
      }

      if ((now - last_frequency_update_tick) >= LED_FREQUENCY_UPDATE_MS)
      {
        float ramp_progress = (float)elapsed / (float)LED_RAMP_DURATION_MS;

        g_led_blink_frequency_hz = LED_START_FREQUENCY_HZ +
            ((LED_MAX_FREQUENCY_HZ - LED_START_FREQUENCY_HZ) * ramp_progress);
        g_led_debug.blink_frequency_hz = g_led_blink_frequency_hz;
        last_frequency_update_tick = now;
      }

      /* Integrate the linear frequency ramp into blink cycles. Updating the
       * output once per HAL tick keeps the observed waveform aligned with the
       * frequency reported by g_led_blink_frequency_hz. */
      if (now != last_phase_update_tick)
      {
        float elapsed_seconds = (float)elapsed / 1000.0f;
        float phase_cycles = (LED_START_FREQUENCY_HZ * elapsed_seconds) +
            (0.5f * ((LED_MAX_FREQUENCY_HZ - LED_START_FREQUENCY_HZ) *
                     1000.0f / (float)LED_RAMP_DURATION_MS) *
             elapsed_seconds * elapsed_seconds);
        uint32_t half_cycle_number;
        uint8_t desired_led_on;

        g_led_debug.timing.phase_cycles = phase_cycles;
        half_cycle_number = (uint32_t)(phase_cycles * 2.0f);
        desired_led_on = (uint8_t)((half_cycle_number & 1U) != 0U);

        if (desired_led_on != led_is_on)
        {
          led_is_on = desired_led_on;
          g_led_transition_handler(led_is_on, elapsed);
        }

        last_phase_update_tick = now;
      }
      break;
    }
  }

  g_led_debug.pwm_duty = led_pwm_duty;
}

/* TIM4 update: software PWM for PC13, 20 kHz tick / 100 steps = 200 Hz PWM. */
void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance != TIM4)
  {
    return;
  }
  led_pwm_tick++;
  if (led_pwm_tick >= LED_PWM_STEPS)
  {
    led_pwm_tick = 0U;
  }
  if (led_pwm_tick < led_pwm_duty)
  {
    LED_GPIO_PORT->BRR = LED_GPIO_PIN;    /* active low: lamp on */
  }
  else
  {
    LED_GPIO_PORT->BSRR = LED_GPIO_PIN;
  }
}

void TIM4_IRQHandler(void)
{
  HAL_TIM_IRQHandler(&htim4);
}

void HAL_UART_TxCpltCallback(UART_HandleTypeDef *huart)
{
  if (huart == &huart1) { g_rm_uart_tx_completed++; }
}
