/**
 * bsp_usart: generic UART DMA receive layer (STM32F1 adaptation).
 *
 *   - Logical UART ids (BSP_UART1/BSP_UART2) are bound to HAL handles through
 *     the uart_dma_map registry, so upper layers never touch huart/hdma.
 *   - HAL_UARTEx_RxEventCallback is implemented here (single definition in the
 *     project) and dispatches IDLE-framed byte chunks to each UART's rx_cb.
 *   - USART2 RX DMA (DMA1_Channel6) is configured here because the CubeMX .ioc
 *     does not declare that DMA request yet; it can move to usart.c later.
 */
#include "bsp_usart.h"
#include "usart.h"

/* IDLE-framed chunks are copied into this linear scratch buffer before the
 * callback runs, so protocols always see contiguous data even across a
 * circular-buffer wrap. Must be >= every registered buffer_size. */
#define BSP_UART_RX_SCRATCH_SIZE 64

typedef struct
{
  UART_HandleTypeDef *huart;
} bsp_uart_dma_map_t;

static const bsp_uart_dma_map_t uart_dma_map[BSP_UART_NUM] =
{
  [BSP_UART1] = { .huart = &huart1 },
  [BSP_UART2] = { .huart = &huart2 },
};

typedef struct
{
  uint8_t *buffer;
  uint16_t buffer_size;
  uint16_t last_pos;          /* circular write index at the previous IDLE */
  bsp_uart_rx_cb_t rx_cb;
  uint8_t active;
} bsp_uart_dma_rx_handle_t;

static bsp_uart_dma_rx_handle_t uart_rx_handles[BSP_UART_NUM] = {0};
static uint8_t rx_scratch[BSP_UART_RX_SCRATCH_SIZE];

/* F1 USART2_RX -> DMA1_Channel6. Kept local until the .ioc declares it. */
static DMA_HandleTypeDef bsp_usart2_rx_dma;
static uint8_t bsp_usart2_dma_ready = 0;

static bsp_uart_dma_rx_handle_t *bsp_uart_handle(bsp_uart_id_t uartx)
{
  if (uartx >= BSP_UART_NUM)
  {
    return NULL;
  }
  return &uart_rx_handles[uartx];
}

static UART_HandleTypeDef *bsp_uart_huart(bsp_uart_id_t uartx)
{
  if (uartx >= BSP_UART_NUM)
  {
    return NULL;
  }
  return uart_dma_map[uartx].huart;
}

static void bsp_uart2_dma_init(void)
{
  if (bsp_usart2_dma_ready)
  {
    return;
  }

  __HAL_RCC_DMA1_CLK_ENABLE();

  bsp_usart2_rx_dma.Instance = DMA1_Channel6;
  bsp_usart2_rx_dma.Init.Direction = DMA_PERIPH_TO_MEMORY;
  bsp_usart2_rx_dma.Init.PeriphInc = DMA_PINC_DISABLE;
  bsp_usart2_rx_dma.Init.MemInc = DMA_MINC_ENABLE;
  bsp_usart2_rx_dma.Init.PeriphDataAlignment = DMA_PDATAALIGN_BYTE;
  bsp_usart2_rx_dma.Init.MemDataAlignment = DMA_MDATAALIGN_BYTE;
  bsp_usart2_rx_dma.Init.Mode = DMA_CIRCULAR;
  bsp_usart2_rx_dma.Init.Priority = DMA_PRIORITY_HIGH;
  if (HAL_DMA_Init(&bsp_usart2_rx_dma) != HAL_OK)
  {
    return;
  }
  __HAL_LINKDMA(&huart2, hdmarx, bsp_usart2_rx_dma);
  bsp_usart2_dma_ready = 1;
}

static void bsp_uart_start_receive(bsp_uart_id_t uartx, bsp_uart_dma_rx_handle_t *h)
{
  UART_HandleTypeDef *huart = bsp_uart_huart(uartx);

  if (uartx == BSP_UART2)
  {
    bsp_uart2_dma_init();
  }
  if (huart == NULL || huart->hdmarx == NULL)
  {
    return;
  }

  h->last_pos = 0;
  if (HAL_UARTEx_ReceiveToIdle_DMA(huart, h->buffer, h->buffer_size) != HAL_OK)
  {
    return;
  }

  /* IDLE is the only receive event this layer needs; leave HT/TC/TE from
   * poking the NVIC so no DMA channel interrupt handler is required. */
  CLEAR_BIT(huart->hdmarx->Instance->CCR, DMA_CCR_HTIE | DMA_CCR_TCIE | DMA_CCR_TEIE);
}

void bsp_uart_dma_rx_init(const BSP_UART_DMA_RX_Config *cfg)
{
  bsp_uart_dma_rx_handle_t *h;
  UART_HandleTypeDef *huart;

  if (cfg == NULL || cfg->buffer == NULL || cfg->buffer_size == 0 ||
      cfg->buffer_size > BSP_UART_RX_SCRATCH_SIZE)
  {
    return;
  }
  h = bsp_uart_handle(cfg->uartx);
  huart = bsp_uart_huart(cfg->uartx);
  if (h == NULL || huart == NULL)
  {
    return;
  }

  h->buffer = cfg->buffer;
  h->buffer_size = cfg->buffer_size;
  h->rx_cb = cfg->rx_cb;
  h->active = 1;
  bsp_uart_start_receive(cfg->uartx, h);
}

void bsp_uart_dma_rx_register_cb(bsp_uart_id_t uartx, bsp_uart_rx_cb_t cb)
{
  bsp_uart_dma_rx_handle_t *h = bsp_uart_handle(uartx);
  if (h != NULL)
  {
    h->rx_cb = cb;
  }
}

void bsp_uart_dma_rx_restart(bsp_uart_id_t uartx)
{
  bsp_uart_dma_rx_handle_t *h = bsp_uart_handle(uartx);
  UART_HandleTypeDef *huart = bsp_uart_huart(uartx);

  if (h == NULL || huart == NULL || !h->active || h->buffer == NULL)
  {
    return;
  }

  /* The HAL error path already aborted the transfer; a normal restart (for
   * example after a receiver hot-plug) still has reception busy. */
  if (huart->RxState != HAL_UART_STATE_READY)
  {
    (void)HAL_UART_AbortReceive(huart);
  }
  bsp_uart_start_receive(uartx, h);
}

void bsp_uart_dma_rx_stop(bsp_uart_id_t uartx)
{
  bsp_uart_dma_rx_handle_t *h = bsp_uart_handle(uartx);
  UART_HandleTypeDef *huart = bsp_uart_huart(uartx);

  if (h == NULL || huart == NULL || !h->active)
  {
    return;
  }
  (void)HAL_UART_AbortReceive(huart);
  h->active = 0;
}

/* HAL global receive event callback (single definition in the project). */
void HAL_UARTEx_RxEventCallback(UART_HandleTypeDef *huart, uint16_t Pos)
{
  for (uint8_t i = 0; i < BSP_UART_NUM; i++)
  {
    bsp_uart_dma_rx_handle_t *h = &uart_rx_handles[i];
    uint16_t delta;

    if (!h->active || h->buffer == NULL || uart_dma_map[i].huart != huart)
    {
      continue;
    }
    if (HAL_UARTEx_GetRxEventType(huart) != HAL_UART_RXEVENT_IDLE)
    {
      return;   /* HT/TC are not used; framing comes from IDLE only */
    }

    delta = (uint16_t)((Pos + h->buffer_size - h->last_pos) % h->buffer_size);
    if (delta > 0 && delta <= BSP_UART_RX_SCRATCH_SIZE)
    {
      for (uint16_t k = 0; k < delta; k++)
      {
        rx_scratch[k] = h->buffer[(uint16_t)((h->last_pos + k) % h->buffer_size)];
      }
      if (h->rx_cb != NULL)
      {
        h->rx_cb((bsp_uart_id_t)i, rx_scratch, delta);
      }
    }
    h->last_pos = Pos;
    return;
  }
}

/* Framing/parity/overrun errors abort DMA reception in the F1 HAL. Recover by
 * restarting reception so a hot-plugged or noisy receiver comes back. */
void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
  for (uint8_t i = 0; i < BSP_UART_NUM; i++)
  {
    if (uart_dma_map[i].huart == huart)
    {
      bsp_uart_dma_rx_restart((bsp_uart_id_t)i);
      return;
    }
  }
}
