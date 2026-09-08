if(NOT DEFINED SOURCE_DIR OR NOT DEFINED PATCH_FILE)
  message(FATAL_ERROR "SOURCE_DIR and PATCH_FILE are required")
endif()

execute_process(
  COMMAND git -C "${SOURCE_DIR}" apply --check "${PATCH_FILE}"
  RESULT_VARIABLE apply_check_result
  ERROR_VARIABLE apply_check_error)

if(apply_check_result EQUAL 0)
  execute_process(
    COMMAND git -C "${SOURCE_DIR}" apply --whitespace=nowarn "${PATCH_FILE}"
    RESULT_VARIABLE apply_result
    ERROR_VARIABLE apply_error)
  if(NOT apply_result EQUAL 0)
    message(FATAL_ERROR "Could not apply ${PATCH_FILE}: ${apply_error}")
  endif()
  message(STATUS "Applied patch: ${PATCH_FILE}")
  return()
endif()

# A failed forward check is acceptable only when the exact patch is already
# present. The reverse check distinguishes that safe case from source drift.
execute_process(
  COMMAND git -C "${SOURCE_DIR}" apply --check --reverse "${PATCH_FILE}"
  RESULT_VARIABLE reverse_check_result
  ERROR_VARIABLE reverse_check_error)
if(reverse_check_result EQUAL 0)
  message(STATUS "Patch already applied: ${PATCH_FILE}")
  return()
endif()

message(FATAL_ERROR
  "${PATCH_FILE} neither applies nor matches the cached source. "
  "Forward check: ${apply_check_error} Reverse check: ${reverse_check_error}")
