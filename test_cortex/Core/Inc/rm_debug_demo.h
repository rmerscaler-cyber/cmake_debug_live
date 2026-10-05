/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file    rm_debug_demo.h
  * @brief   rm_debug extension demo fixture: LED blink ramp, Live Watch
  *          snapshot, and RM2 telemetry. Kept out of main.c so CubeMX
  *          regeneration cannot overwrite the implementation.
  ******************************************************************************
  */
/* USER CODE END Header */

/* Define to prevent recursive inclusion -------------------------------------*/
#ifndef __RM_DEBUG_DEMO_H
#define __RM_DEBUG_DEMO_H

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include <stdint.h>

/* Exported types ------------------------------------------------------------*/
typedef struct
{
  uint32_t last_transition_ms;
  uint32_t last_interval_ms;
  float phase_cycles;
} LedTimingDebug;

typedef void (*LedTransitionHandler)(uint8_t is_on, uint32_t elapsed_ms);

typedef struct
{
  uint32_t uptime_ms;
  float blink_frequency_hz;
  uint32_t transition_count;
  uint32_t led_on;
  uint32_t steady_on;
  LedTransitionHandler transition_handler;
  LedTimingDebug timing;
  uint32_t recent_intervals_ms[4]; /* Newest interval is element 0. */
  uint32_t frequency_history_count;
  uint32_t frequency_history_millihz[300]; /* Fills in 25 ms steps for paging demo. */
  uint32_t led_mode;      /* 0 = ramp (s[2] up), 1 = breathing (mid), 2 = fast blink (down) */
  uint32_t pwm_duty;      /* software PWM duty on PC13, 0..100 */
} LedDebugSnapshot;

/* Exported variables --------------------------------------------------------*/
/* Add these to Live Watch to inspect scalar, nested, array and function
 * pointer fields; g_led_debug carries most of the snapshot. */
extern volatile float g_led_blink_frequency_hz;
extern volatile uint8_t g_led_ramp_complete;
extern volatile LedDebugSnapshot g_led_debug;

/* Observe these when serial data does not reach the PC. */
extern volatile uint32_t g_rm_uart_tx_started;
extern volatile uint32_t g_rm_uart_tx_completed;
extern volatile uint32_t g_rm_uart_tx_failed;

/* Watch this global pointer to see its current function target change. */
extern LedTransitionHandler volatile g_led_transition_handler;

/* Exported functions prototypes ---------------------------------------------*/
/* Call after MX_GPIO_Init, MX_DMA_Init and MX_USART1_UART_Init. */
void RM_DebugDemoInit(void);

/* Call continuously from the main loop. */
void RM_DebugDemoUpdate(void);

#ifdef __cplusplus
}
#endif

#endif /* __RM_DEBUG_DEMO_H */
